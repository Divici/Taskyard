import { z } from 'zod'
import { normalizeAccelerator } from '@shared/accelerator'
import { IPC, type PeekState, type ShortcutStatus } from '@shared/ipc'
import type { SettingsFile } from '@shared/schema'
import { handleTrusted, type IpcMainLike, type TrustedHandlerOptions } from '../ipc/sender-guard'
import type { IdlePauseSource, PeekOptions } from '../windows/desktop-window-manager'

// Peek's inputs (Phase 9). The window manager owns Peek itself — the topmost state, holds and the
// 8 s idle timer (src/main/windows/desktop-window-manager.ts). This module drives it: the global
// shortcut (rebindable through settings.peekShortcut), the tray/second-instance entry points, and
// the renderer signals: text-input focus (pauses the idle timer), activity (restarts it) and a
// click outside every group (ends the Peek).

/** The slice of Electron's `globalShortcut` used here (injectable: tests never load Electron). */
export interface GlobalShortcutLike {
  /** False when another app owns the accelerator; throws when Electron cannot parse it. */
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

/** What this module needs of the window manager. */
export interface PeekTarget {
  readonly peeking: boolean
  peek(on: boolean, options?: PeekOptions): void
  pauseIdle(paused: boolean, source?: IdlePauseSource): void
  noteActivity(): void
}

export interface PeekShortcutsDeps {
  globalShortcut: GlobalShortcutLike
  /** The window manager, or null before the desktop windows exist (Peek is then a no-op). */
  target: () => PeekTarget | null
  /** Sends `peek:shortcut` to every window when the registration outcome changes. */
  emit: (status: ShortcutStatus) => void
  log: { info(message: string): void; warn(message: string, ...details: unknown[]): void }
}

export interface PeekShortcuts {
  /** Registers the settings' shortcut at boot (app ready, settings loaded). */
  start(settings: SettingsFile): ShortcutStatus
  /**
   * Follows a settings save (Phase 11's Settings UI changes `peekShortcut` in the settings store;
   * main gets every accepted save). Only a changed `peekShortcut` is acted on, so a shortcut that
   * failed is not retried on every unrelated save.
   */
  applySettings(settings: SettingsFile): void
  /**
   * Registers `accelerator` as the Peek shortcut in place of the current one. On failure the
   * current one stays registered, and the returned (and emitted) status says why.
   */
  setShortcut(accelerator: string): ShortcutStatus
  status(): ShortcutStatus
  /** Peek on ↔ off: the shortcut, and Phase 11's tray "Peek". */
  togglePeek(): void
  /** Peek on (a second launch of Taskyard: the user is looking for it). */
  showPeek(): void
  /** A text input in window `windowId` gained or lost focus; the idle timer waits while any has. */
  inputFocus(windowId: number, focused: boolean): void
  /** Pointer or keyboard activity during a Peek: restarts the idle timer. */
  activity(): void
  /** A click outside every group and panel: ends the Peek at once (holds included). */
  clickOutside(): void
  /** Unregisters the shortcut (will-quit). */
  dispose(): void
}

export function createPeekShortcuts(deps: PeekShortcutsDeps): PeekShortcuts {
  const { globalShortcut, log } = deps
  /** The settings value last acted on (canonical or raw), so unrelated saves are ignored. */
  let requested: string | null = null
  let active: string | null = null
  let current: ShortcutStatus = { accelerator: '', active: null, error: null }

  function turnOn(): void {
    // The manager owns the idle pauses (per window, all dropped when a Peek ends); every window
    // reports its focus state again when it hears peek:changed.
    deps.target()?.peek(true)
  }

  function togglePeek(): void {
    const target = deps.target()
    if (!target) return
    if (target.peeking) target.peek(false)
    else turnOn()
  }

  /** Tries to register; true on success, else why not. */
  function tryRegister(accelerator: string): true | 'invalid' | 'in-use' {
    try {
      return globalShortcut.register(accelerator, togglePeek) ? true : 'in-use'
    } catch (error) {
      log.warn(`shortcuts: Electron refused the accelerator ${accelerator}`, error)
      return 'invalid'
    }
  }

  function publish(status: ShortcutStatus): ShortcutStatus {
    const same =
      status.accelerator === current.accelerator &&
      status.active === current.active &&
      status.error === current.error
    current = status
    if (!same) deps.emit(status)
    return status
  }

  function setShortcut(input: string): ShortcutStatus {
    requested = input
    const accelerator = normalizeAccelerator(input)
    if (accelerator === null) {
      log.warn(`shortcuts: "${input}" is not a valid Peek shortcut; keeping ${active ?? 'none'}`)
      return publish({ accelerator: input, active, error: 'invalid' })
    }
    if (accelerator === active) return publish({ accelerator, active, error: null })

    const previous = active
    if (previous !== null) globalShortcut.unregister(previous)
    active = null
    const outcome = tryRegister(accelerator)
    if (outcome === true) {
      active = accelerator
      log.info(`shortcuts: Peek shortcut is ${accelerator}`)
      return publish({ accelerator, active, error: null })
    }
    // Keep Peek reachable: put the previous shortcut back.
    if (previous !== null && tryRegister(previous) === true) active = previous
    log.warn(
      `shortcuts: could not register ${accelerator} (${outcome === 'in-use' ? 'used by another app' : 'invalid'}); ` +
        `Peek shortcut is ${active ?? 'none'}`
    )
    return publish({ accelerator, active, error: outcome })
  }

  return {
    start: (settings) => setShortcut(settings.peekShortcut),
    applySettings(settings) {
      if (settings.peekShortcut !== requested) setShortcut(settings.peekShortcut)
    },
    setShortcut,
    status: () => ({ ...current }),
    togglePeek,
    showPeek() {
      if (!deps.target()?.peeking) turnOn()
    },
    inputFocus(windowId, focused) {
      deps.target()?.pauseIdle(focused, windowId)
    },
    activity() {
      deps.target()?.noteActivity()
    },
    clickOutside() {
      const target = deps.target()
      if (!target?.peeking) return
      log.info('peek: click outside a group, unpeeking')
      target.peek(false)
    },
    dispose() {
      if (active !== null) globalShortcut.unregister(active)
      active = null
    }
  }
}

export interface PeekIpcSource {
  shortcuts: PeekShortcuts
  /** The window manager's state (false before the windows exist). */
  peeking: () => boolean
}

const Args = {
  none: z.tuple([]),
  focused: z.tuple([z.boolean()])
}

/**
 * The renderer side of Peek: `peek:get` (pull, for a window that loads during a Peek), the input
 * focus / activity / click-outside signals and the shortcut status. Taskyard renderer only, and
 * every argument checked. Returns a function that removes the handlers.
 */
export function registerPeekIpc(
  ipc: IpcMainLike,
  trust: TrustedHandlerOptions,
  source: PeekIpcSource
): () => void {
  const parse = <T>(channel: string, schema: z.ZodType<T>, args: unknown[]): T => {
    const result = schema.safeParse(args)
    if (result.success) return result.data
    trust.log.warn(`ipc: invalid arguments for ${channel}`, z.prettifyError(result.error))
    throw new Error(`invalid arguments for ${channel}`)
  }

  handleTrusted(ipc, IPC.peek.get, trust, (_event, args): PeekState => {
    parse(IPC.peek.get, Args.none, args)
    return { peeking: source.peeking() }
  })
  handleTrusted(ipc, IPC.peek.inputFocus, trust, (event, args) => {
    const [focused] = parse(IPC.peek.inputFocus, Args.focused, args)
    source.shortcuts.inputFocus(event.sender.id, focused)
  })
  handleTrusted(ipc, IPC.peek.activity, trust, (_event, args) => {
    parse(IPC.peek.activity, Args.none, args)
    source.shortcuts.activity()
  })
  handleTrusted(ipc, IPC.peek.clickOutside, trust, (_event, args) => {
    parse(IPC.peek.clickOutside, Args.none, args)
    source.shortcuts.clickOutside()
  })
  handleTrusted(ipc, IPC.peek.shortcutStatus, trust, (_event, args) => {
    parse(IPC.peek.shortcutStatus, Args.none, args)
    return source.shortcuts.status()
  })

  return () => {
    for (const channel of Object.values(IPC.peek)) ipc.removeHandler(channel)
  }
}
