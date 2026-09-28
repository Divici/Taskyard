import type { DisplayInfo, PeekState } from '@shared/ipc'
import { createEventEmitter, type IpcEventEmitter } from '../ipc/events'
import type { Hwnd, Unsubscribe, Win32Api, ZOrderMode } from '../win32/api'
import {
  createDesktopWindow,
  type DesktopBrowserWindowConstructor,
  type DesktopLog,
  type DesktopWindow,
  type RendererSource
} from './desktop-window'
import { toDisplayInfo, type DisplaySource } from './display-ipc'
import {
  createReseatThrottle,
  RESEAT_THROTTLE,
  type ReseatThrottleOptions
} from './reseat-throttle'

/** Peek drops back to the desktop layer after this long without activity. */
export const IDLE_UNPEEK_MS = 8_000
/** The z-order sentinel's poll: catches what the foreground hook cannot see (Explorer restart). */
export const ZORDER_POLL_MS = 500
/**
 * Win+D activates the desktop first and raises the shell window a moment later, so a check
 * made on the foreground event alone finds nothing wrong; this second look catches the raise.
 */
export const FOREGROUND_SETTLE_MS = 150
/** A display's window destroyed from outside is recreated at most this many times … */
export const RECREATE_LIMIT = 5
/** … within this long; past that the recreation loop is logged and paused … */
export const RECREATE_WINDOW_MS = 60_000
/** … and the display gets one more window after this long (again after each failure). */
export const RECREATE_COOLDOWN_MS = 5 * 60_000
/** A new shell window (Explorer restarted) bypasses the poll's back-off for this long. */
export const SHELL_CHANGE_GRACE_MS = 10_000

/** Why a peek must stay up regardless of the idle timer (Phase 9 adds more). */
export type PeekHold = 'inspector'

export interface PeekOptions {
  hold?: PeekHold
}

/** Who paused the idle timer: a desktop window's webContents id, or 'manual'. */
export type IdlePauseSource = number | 'manual'

/** The slice of Electron's `screen` used here; one overload per event, as Electron types it. */
export interface ScreenLike {
  getAllDisplays(): DisplayInfo[]
  on(event: 'display-added', listener: () => void): unknown
  on(event: 'display-removed', listener: () => void): unknown
  on(event: 'display-metrics-changed', listener: () => void): unknown
  removeListener(event: 'display-added', listener: () => void): unknown
  removeListener(event: 'display-removed', listener: () => void): unknown
  removeListener(event: 'display-metrics-changed', listener: () => void): unknown
}

type PowerEvent = 'resume' | 'suspend' | 'lock-screen' | 'unlock-screen'

export interface PowerMonitorLike {
  on(event: PowerEvent, listener: () => void): unknown
  removeListener(event: PowerEvent, listener: () => void): unknown
}

export interface ElectronDeps {
  BrowserWindow: DesktopBrowserWindowConstructor
  screen: ScreenLike
  powerMonitor: PowerMonitorLike
}

export interface DesktopWindowManagerDeps {
  electron: ElectronDeps
  api: Win32Api
  preloadPath: string
  renderer: RendererSource
  log: DesktopLog
  idleMs?: number
  pollMs?: number
  settleMs?: number
  throttle?: ReseatThrottleOptions
  /** Quits the app gracefully (`app.quit()`), so before-quit and the store flush run. */
  requestQuit: () => void
  /** F12 toggles DevTools on the desktop windows. Development builds only (`!app.isPackaged`). */
  devTools?: boolean
  /** Any desktop window received WM_SETTINGCHANGE (wallpaper, theme; once per window). */
  onSettingChange?: () => void
}

export interface DesktopWindowManager extends DisplaySource, IpcEventEmitter {
  /**
   * Opens a window per display and starts the display listeners and the z-order sentinel. All or
   * nothing: if any step throws, the windows it opened are closed, every listener and timer is
   * removed, and the error is rethrown.
   */
  start(): void
  /** Stops timers, the foreground hook and the listeners. Windows close with the app. */
  dispose(): void
  /** From here on windows may close (app quit) and none is recreated. Call on before-quit. */
  prepareToQuit(): void
  /**
   * The quit did not happen after all: windows refuse outside closes again, the sentinel resumes
   * and a display whose window closed meanwhile gets a new one.
   */
  cancelQuit(): void
  readonly quitting: boolean
  /** The single source of truth for Peek: read by every guard, broadcast as `peek:changed`. */
  readonly peeking: boolean
  /** Raises every desktop window topmost (on) or re-seats them (off, which drops all holds). */
  peek(on: boolean, options?: PeekOptions): void
  /** Lets the idle timer run again once no hold remains. */
  releaseHold(hold: PeekHold): void
  /**
   * Suspends the idle timer while any pauser is paused. `source` is a renderer's webContents id
   * (a text input focused in that window) or 'manual'. A window's pause is dropped when its page
   * navigates, crashes, finishes (re)loading or closes; every pause is dropped when Peek ends.
   */
  pauseIdle(paused: boolean, source?: IdlePauseSource): void
  /** Restarts the idle timer (Phase 9: pointer or keyboard activity during Peek). */
  noteActivity(): void
  /** Shows and re-seats (or re-raises while peeking) every ready window. */
  reseatAll(): void
  windows(): readonly DesktopWindow[]
  /**
   * The one broadcast to the desktop windows (every main → renderer event goes through it):
   * each live window gets the event; one that cannot be reached is logged and skipped.
   */
  emit: IpcEventEmitter['emit']
}

export function createDesktopWindowManager(deps: DesktopWindowManagerDeps): DesktopWindowManager {
  const { electron, api, log } = deps
  const idleMs = deps.idleMs ?? IDLE_UNPEEK_MS
  const pollMs = deps.pollMs ?? ZORDER_POLL_MS
  const settleMs = deps.settleMs ?? FOREGROUND_SETTLE_MS
  const throttleOptions = deps.throttle ?? RESEAT_THROTTLE
  const throttle = createReseatThrottle(throttleOptions)

  const byDisplay = new Map<number, DesktopWindow>()
  const holds = new Set<PeekHold>()
  let peeking = false
  let quitting = false
  /** Pausers of the idle timer; owned here next to the holds, cleared when Peek ends. */
  const idlePausers = new Set<IdlePauseSource>()
  /** Each window's webContents id, kept past its destruction (to drop its pause). */
  const contentsIds = new Map<DesktopWindow, number>()
  /** Locked screen and sleep are separate: the sentinel runs only when neither applies. */
  let locked = false
  let suspended = false
  /**
   * The shell window the desktop windows were last re-seated against. A different one means
   * Explorer restarted since then; its displacement bypasses the back-off, even if clean checks
   * saw the new shell window first.
   */
  let seatedShell: Hwnd | null = null
  /** The newest shell window seen, and when it replaced the one before (Explorer restarted). */
  let knownShell: Hwnd | null = null
  let shellChangedAt = Number.NEGATIVE_INFINITY
  const cooldowns = new Map<number, ReturnType<typeof setTimeout>>()
  const destructions = new Map<number, number[]>()
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let unwatchForeground: Unsubscribe | null = null
  let started = false
  let displacedStreak = false
  let fightWarned = false

  const mode = (): ZOrderMode => (peeking ? 'peek' : 'bottom')
  const all = (): DesktopWindow[] => [...byDisplay.values()]
  const readyWindows = (): DesktopWindow[] => all().filter((desktop) => desktop.ready)

  const getDisplay = (id: number): DisplayInfo | null => {
    const display = electron.screen.getAllDisplays().find((d) => d.id === id)
    return display ? toDisplayInfo(display) : null
  }

  // Every event to the renderers — display, peek, storage, and later phases' — goes through here.
  const events = createEventEmitter(all, (desktop: DesktopWindow) => desktop.contents(), log)
  const peekState = (): PeekState => ({ peeking })

  /** A window's page is gone or new: whatever it reported (its input-focus pause) is stale. */
  const forgetRenderer = (desktop: DesktopWindow): void => {
    const id = contentsIds.get(desktop)
    if (id === undefined || !idlePausers.delete(id)) return
    scheduleIdle()
  }

  const sendState = (desktop: DesktopWindow): void => {
    // The fresh page reports its focus again when it hears peek:changed.
    forgetRenderer(desktop)
    const info = getDisplay(desktop.displayId)
    if (info) events.emitTo(desktop, 'display:changed', info)
    events.emitTo(desktop, 'peek:changed', peekState())
  }

  /** Each window gets its own display's info. */
  const broadcastDisplays = (): void => {
    events.emitEach('display:changed', (desktop) => getDisplay(desktop.displayId))
  }

  const broadcastPeek = (): void => {
    events.emit('peek:changed', peekState())
  }

  const onWindowClosed = (closed: DesktopWindow, { expected }: { expected: boolean }): void => {
    forgetRenderer(closed)
    contentsIds.delete(closed)
    if (byDisplay.get(closed.displayId) !== closed) return
    byDisplay.delete(closed.displayId)
    if (expected || quitting) return
    // Destroyed from outside: the display must not be left without its desktop layer. Never
    // inside `closed` itself (app.exit() would never see the window list empty), and capped.
    const id = closed.displayId
    const now = Date.now()
    const recent = [...(destructions.get(id) ?? []), now].filter(
      (at) => now - at < RECREATE_WINDOW_MS
    )
    destructions.set(id, recent)
    if (recent.length > RECREATE_LIMIT) {
      log.error(
        `desktop: the window on display ${id} was destroyed ${recent.length} times in ${RECREATE_WINDOW_MS / 1000} s; not recreating it`
      )
      scheduleCooldownRetry(id)
      return
    }
    later(() => {
      if (quitting || byDisplay.has(id)) return
      const display = electron.screen.getAllDisplays().find((d) => d.id === id)
      if (display === undefined) return
      log.warn(`desktop: the window on display ${id} was destroyed; recreating it`)
      openWindow(display)
    })
  }

  /** After the recreation cap, one more window for `id` after a long pause. */
  function scheduleCooldownRetry(id: number): void {
    if (cooldowns.has(id)) return
    const timer = setTimeout(() => {
      cooldowns.delete(id)
      if (quitting || byDisplay.has(id)) return
      const display = electron.screen.getAllDisplays().find((d) => d.id === id)
      if (display === undefined) return
      destructions.delete(id)
      log.info(
        `desktop: retrying the window on display ${id} after a ${RECREATE_COOLDOWN_MS / 60_000} min pause`
      )
      openWindow(display)
    }, RECREATE_COOLDOWN_MS)
    cooldowns.set(id, timer)
  }

  /** Runs `fn` on a later tick; cancelled by dispose(). */
  function later(fn: () => void): void {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer)
      fn()
    }, 0)
    pendingTimers.add(timer)
  }

  const onCloseRequest = (desktop: DesktopWindow): void => {
    log.info(
      `desktop: close requested for display ${desktop.displayId} from outside; quitting the app`
    )
    later(() => {
      if (!quitting) deps.requestQuit()
    })
  }

  function openWindow(display: DisplayInfo): void {
    const desktop = createDesktopWindow(display, {
      BrowserWindow: electron.BrowserWindow,
      api,
      preloadPath: deps.preloadPath,
      renderer: deps.renderer,
      log,
      mode,
      canClose: () => quitting,
      onClosed: onWindowClosed,
      onCloseRequest,
      onRendererLoaded: sendState,
      onRendererReset: forgetRenderer,
      devTools: deps.devTools,
      onSettingChange: deps.onSettingChange
    })
    byDisplay.set(display.id, desktop)
    contentsIds.set(desktop, desktop.window.webContents.id)
  }

  /** Opens missing windows before closing stale ones, so the app never has zero windows. */
  const syncDisplays = (): void => {
    const displays = electron.screen.getAllDisplays()
    for (const display of displays) {
      const existing = byDisplay.get(display.id)
      if (existing) existing.setDisplay(display)
      else openWindow(display)
    }
    const current = new Set(displays.map((display) => display.id))
    for (const [id, desktop] of byDisplay) {
      if (current.has(id)) continue
      byDisplay.delete(id)
      desktop.close()
    }
    broadcastDisplays()
    reseatAll()
  }

  const clearIdle = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = null
  }

  const scheduleIdle = (): void => {
    clearIdle()
    if (!peeking || holds.size > 0 || idlePausers.size > 0) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      log.info(`peek: idle for ${idleMs} ms, unpeeking`)
      peek(false)
    }, idleMs)
  }

  function reseatAll(): void {
    for (const desktop of readyWindows()) desktop.reseat()
    seatedShell = api.getShellWindow() ?? seatedShell
  }

  function peek(on: boolean, options: PeekOptions = {}): void {
    if (on) {
      if (options.hold) holds.add(options.hold)
      if (!peeking) {
        // Order matters: the guards read `peeking`, so it flips before the windows move.
        peeking = true
        for (const desktop of readyWindows()) api.setTopmost(desktop.hwnd, true)
        log.info('peek: on')
        broadcastPeek()
      }
      scheduleIdle()
      return
    }

    // A Peek's holds and pauses end with it: a later Peek never inherits a stale one.
    holds.clear()
    idlePausers.clear()
    clearIdle()
    if (!peeking) return
    peeking = false
    for (const desktop of readyWindows()) {
      api.setTopmost(desktop.hwnd, false)
      api.seatAboveShell(desktop.hwnd)
    }
    log.info('peek: off')
    broadcastPeek()
  }

  /** Why a ready desktop window is out of place, or null when it is where it should be. */
  const displacement = (
    desktop: DesktopWindow,
    shell: Hwnd | null,
    ours: ReadonlySet<Hwnd>
  ): string | null => {
    if (desktop.displaced()) return 'minimized or hidden'
    const topmost = api.isTopmost(desktop.hwnd)
    if (peeking) return topmost ? null : 'not topmost while peeking'
    if (topmost) return 'topmost while not peeking'
    if (shell === null) return null
    if (api.isAbove(shell, desktop.hwnd)) return 'shell window above it'
    // Undoing Win+D restores some app windows below us; they must not stay hidden behind us.
    const covered = api.visibleWindowsBetween(desktop.hwnd, shell).filter((h) => !ours.has(h))
    return covered.length > 0 ? `covering ${covered.length} app window(s)` : null
  }

  /** The sentinel: put every window back when one is out of place, backing off from a fight. */
  const checkSeating = (reason: 'poll' | 'foreground'): void => {
    if (locked || suspended || quitting) return
    const now = Date.now()
    const shell = api.getShellWindow()
    if (shell !== null && shell !== knownShell) {
      if (knownShell !== null) shellChangedAt = now
      knownShell = shell
    }
    // Explorer restarted: since the last re-seat, or recently (it may re-raise while starting).
    const shellChanged =
      (shell !== null && seatedShell !== null && shell !== seatedShell) ||
      now - shellChangedAt < SHELL_CHANGE_GRACE_MS
    // Only a poll-only fight backs off. Foreground changes (Win+D and its undo) and a new shell
    // window (Explorer restarted) are always repaired at once.
    const throttled = reason === 'poll' && !shellChanged
    if (throttled && !throttle.allows(now)) return
    const candidates = readyWindows()
    if (candidates.length === 0) return
    const ours = new Set(all().map((desktop) => desktop.hwnd))
    const causes = candidates
      .map((desktop) => displacement(desktop, shell, ours))
      .filter((cause): cause is string => cause !== null)
    if (causes.length === 0) {
      displacedStreak = false
      if (throttle.settle(now)) {
        fightWarned = false
        log.info('zorder: settled; re-seat back-off reset')
      }
      return
    }
    if (!displacedStreak) {
      displacedStreak = true
      const why = shellChanged ? 'a new shell window' : reason
      log.info(`zorder: re-seating after ${why} (${[...new Set(causes)].join('; ')})`)
    }
    reseatAll()
    if (!throttled) return
    const backoff = throttle.record(now)
    if (backoff > 0 && !fightWarned) {
      fightWarned = true
      log.warn(
        `zorder: re-seated more than ${throttleOptions.limit} times in ` +
          `${throttleOptions.windowMs / 1000} s; another app may be fighting for the desktop ` +
          `layer. Backing off (${backoff} ms, doubling up to ${throttleOptions.maxBackoffMs / 1000} s)`
      )
    }
  }

  /**
   * Phase 9: another app came to the front (a taskbar button, Alt+Tab) — the user has left the
   * Peek, so it ends. Our own windows and the shell window (Win+D) do not end it, nor (Phase 12)
   * the tray (the taskbar, its overflow flyout, or our own tray icon window while the tray menu
   * is open): using Taskyard's tray icon focuses them first, and ending the Peek there would make
   * the tray's Peek toggle turn it straight back on.
   */
  const endPeekOnForeignForeground = (hwnd: Hwnd | null): void => {
    if (!peeking || hwnd === null || hwnd === api.getShellWindow()) return
    if (all().some((desktop) => desktop.hwnd === hwnd)) return
    if (api.isTrayWindow(hwnd)) return
    log.info('peek: another app took the foreground, unpeeking')
    peek(false)
  }

  const onForeground = (hwnd: Hwnd | null = null): void => {
    endPeekOnForeignForeground(hwnd)
    checkSeating('foreground')
    if (settleTimer !== null) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = null
      checkSeating('foreground')
    }, settleMs)
  }

  const startPoll = (): void => {
    if (pollTimer === null) pollTimer = setInterval(() => checkSeating('poll'), pollMs)
  }
  const stopPoll = (): void => {
    if (pollTimer !== null) clearInterval(pollTimer)
    pollTimer = null
  }

  const pause = (flag: 'locked' | 'suspended'): void => {
    if (flag === 'locked') locked = true
    else suspended = true
    stopPoll()
  }
  const wake = (flag: 'locked' | 'suspended'): void => {
    if (flag === 'locked') locked = false
    else suspended = false
    log.info(`zorder: re-seating after ${flag === 'locked' ? 'unlock' : 'resume'}`)
    reseatAll()
    if (!locked && !suspended) startPoll()
  }
  const onLock = (): void => pause('locked')
  const onUnlock = (): void => wake('locked')
  const onSuspend = (): void => pause('suspended')
  const onResume = (): void => wake('suspended')

  const watchDisplays = (on: boolean): void => {
    const { screen } = electron
    if (on) {
      screen.on('display-added', syncDisplays)
      screen.on('display-removed', syncDisplays)
      screen.on('display-metrics-changed', syncDisplays)
    } else {
      screen.removeListener('display-added', syncDisplays)
      screen.removeListener('display-removed', syncDisplays)
      screen.removeListener('display-metrics-changed', syncDisplays)
    }
  }

  const watchPower = (on: boolean): void => {
    const { powerMonitor } = electron
    const pairs: [PowerEvent, () => void][] = [
      ['suspend', onSuspend],
      ['lock-screen', onLock],
      ['resume', onResume],
      ['unlock-screen', onUnlock]
    ]
    for (const [event, listener] of pairs) {
      if (on) powerMonitor.on(event, listener)
      else powerMonitor.removeListener(event, listener)
    }
  }

  /** Stops timers, the foreground hook and the listeners (removing one never added is a no-op). */
  const stopWatching = (): void => {
    stopPoll()
    if (settleTimer !== null) clearTimeout(settleTimer)
    settleTimer = null
    clearIdle()
    for (const timer of pendingTimers) clearTimeout(timer)
    pendingTimers.clear()
    for (const timer of cooldowns.values()) clearTimeout(timer)
    cooldowns.clear()
    unwatchForeground?.()
    unwatchForeground = null
    watchDisplays(false)
    watchPower(false)
  }

  return {
    start() {
      if (started) return
      started = true
      try {
        seatedShell = api.getShellWindow()
        knownShell = seatedShell
        for (const display of electron.screen.getAllDisplays()) openWindow(display)
        watchDisplays(true)
        watchPower(true)
        try {
          unwatchForeground = api.watchForeground(onForeground)
        } catch (error) {
          log.warn('zorder: foreground hook unavailable, relying on the poll', error)
        }
        startPoll()
      } catch (error) {
        // All or nothing: a half-started desktop (some windows, no sentinel) must not linger.
        started = false
        stopWatching()
        const opened = all()
        byDisplay.clear()
        for (const desktop of opened) {
          try {
            desktop.close()
          } catch (closeError) {
            log.error(
              `desktop: closing the window on display ${desktop.displayId} failed`,
              closeError
            )
          }
        }
        throw error
      }
    },

    dispose() {
      if (!started) return
      started = false
      stopWatching()
    },

    prepareToQuit() {
      quitting = true
    },
    cancelQuit() {
      if (!quitting) return
      quitting = false
      if (!started) return
      log.warn('desktop: the quit was cancelled; the desktop windows stay and are guarded again')
      syncDisplays()
    },
    get quitting() {
      return quitting
    },
    get peeking() {
      return peeking
    },
    peek,
    releaseHold(hold) {
      holds.delete(hold)
      scheduleIdle()
    },
    pauseIdle(paused, source = 'manual') {
      if (paused) idlePausers.add(source)
      else idlePausers.delete(source)
      scheduleIdle()
    },
    noteActivity() {
      if (peeking) scheduleIdle()
    },
    reseatAll,
    windows: all,
    emit: events.emit,
    getDisplay,
    listDisplays: () => electron.screen.getAllDisplays().map(toDisplayInfo)
  }
}
