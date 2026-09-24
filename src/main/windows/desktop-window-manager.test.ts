import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createFakeWin32Api, FAKE_APP_WINDOW, type FakeWin32Api } from '../win32/fake-api'
import {
  createFakeElectron,
  fakeDisplay,
  FakeBrowserWindow,
  PRIMARY_DISPLAY,
  recordShowOrder,
  SECONDARY_DISPLAY,
  type FakeElectron
} from '../test/fake-electron'
import {
  createDesktopWindowManager,
  FOREGROUND_SETTLE_MS,
  IDLE_UNPEEK_MS,
  RECREATE_COOLDOWN_MS,
  SHELL_CHANGE_GRACE_MS,
  RECREATE_LIMIT,
  RECREATE_WINDOW_MS,
  ZORDER_POLL_MS,
  type DesktopWindowManager,
  type DesktopWindowManagerDeps
} from './desktop-window-manager'
import { registerDisplayIpc, type IpcMainLike } from './display-ipc'

const PRELOAD = 'C:\\app\\out\\preload\\index.js'
const INDEX_HTML = 'C:\\app\\out\\renderer\\index.html'

let electron: FakeElectron
let api: FakeWin32Api
let manager: DesktopWindowManager
let requestQuit: Mock<() => void>
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn(), debug: vi.fn() }

function start(overrides: Partial<DesktopWindowManagerDeps> = {}): DesktopWindowManager {
  manager = createDesktopWindowManager({
    electron,
    api,
    preloadPath: PRELOAD,
    renderer: { kind: 'file', path: INDEX_HTML },
    log,
    requestQuit,
    ...overrides
  })
  manager.start()
  return manager
}

const windows = (): FakeBrowserWindow[] => FakeBrowserWindow.instances
const reseatCount = (): number => api.callsTo('seatAboveShell').length / live().length
const live = (): FakeBrowserWindow[] => windows().filter((window) => !window.destroyed)

/** Every window paints its first frame and is shown. */
function allReady(): void {
  for (const window of live()) {
    window.becomeReady()
    window.visible = true
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  electron = createFakeElectron()
  api = createFakeWin32Api()
  requestQuit = vi.fn()
})

afterEach(() => {
  manager?.dispose()
  vi.useRealTimers()
})

describe('desktop windows per display', () => {
  it('creates one desktop window per display, covering it with a 1 px bottom inset', () => {
    start()

    expect(windows()).toHaveLength(2)
    expect(windows().map((window) => window.bounds)).toEqual([
      { x: 0, y: 0, width: 2560, height: 1439 },
      { x: 2560, y: 0, width: 1920, height: 1079 }
    ])
    expect(windows().every((window) => window.options.type === 'toolbar')).toBe(true)
    expect(windows().every((window) => window.options.skipTaskbar === true)).toBe(true)
    expect(manager.windows().map((desktop) => desktop.displayId)).toEqual([
      PRIMARY_DISPLAY.id,
      SECONDARY_DISPLAY.id
    ])
  })

  it('loads each renderer with its own displayId in the URL and argv', () => {
    start({ renderer: { kind: 'url', url: 'http://localhost:5173/' } })

    expect(windows().map((window) => window.loads[0].target)).toEqual([
      `http://localhost:5173/?displayId=${PRIMARY_DISPLAY.id}`,
      `http://localhost:5173/?displayId=${SECONDARY_DISPLAY.id}`
    ])
    expect(windows()[1].options.webPreferences?.additionalArguments).toEqual([
      `--display-id=${SECONDARY_DISPLAY.id}`
    ])
  })

  it('answers display:get with bounds, workArea and scaleFactor', async () => {
    start()
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipcMain: IpcMainLike = {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel)
    }
    registerDisplayIpc(ipcMain, manager)

    expect(handlers.get('display:get')!({}, SECONDARY_DISPLAY.id)).toEqual({
      id: SECONDARY_DISPLAY.id,
      bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
      workArea: { x: 2560, y: 0, width: 1920, height: 1032 },
      scaleFactor: 1.5
    })
    expect(handlers.get('display:list')!({})).toHaveLength(2)
  })

  it('calls seatAboveShell after showing each window without activation', () => {
    const order = recordShowOrder(api)
    start()
    expect(api.callsTo('seatAboveShell')).toEqual([])

    for (const window of windows()) window.becomeReady()

    const [first, second] = windows()
    expect(order).toEqual([
      `showInactive ${first.hwnd}`,
      `seatAboveShell ${first.hwnd}`,
      `installZOrderGuard ${first.hwnd}`,
      `showInactive ${second.hwnd}`,
      `seatAboveShell ${second.hwnd}`,
      `installZOrderGuard ${second.hwnd}`
    ])
    expect(api.callsTo('watchForeground')).toHaveLength(1)
    expect(api.isAbove(first.hwnd, api.getShellWindow()!)).toBe(true)
    expect(api.isAbove(second.hwnd, api.getShellWindow()!)).toBe(true)
  })

  it('re-seats every window when the system resumes from sleep', () => {
    start()
    allReady()
    api.clearCalls()

    electron.powerMonitor.emit('resume')

    expect(api.callsTo('seatAboveShell')).toEqual(windows().map((w) => [w.hwnd]))
  })
})

describe('peek', () => {
  it('raises every desktop window topmost and emits peek:changed', () => {
    start()
    allReady()
    api.clearCalls()

    manager.peek(true)

    expect(manager.peeking).toBe(true)
    expect(api.callsTo('setTopmost')).toEqual(windows().map((w) => [w.hwnd, true]))
    expect(windows().every((w) => api.isTopmostWindow(w.hwnd))).toBe(true)
    expect(windows().every((w) => api.guardMode(w.hwnd) === 'peek')).toBe(true)
    for (const window of windows()) {
      expect(window.webContents.sentOn('peek:changed')).toEqual([{ peeking: true }])
    }
  })

  it('re-seats every window above the shell window when peek ends', () => {
    start()
    allReady()
    manager.peek(true)
    api.clearCalls()

    manager.peek(false)

    expect(manager.peeking).toBe(false)
    expect(api.callsTo('setTopmost')).toEqual(windows().map((w) => [w.hwnd, false]))
    expect(api.callsTo('seatAboveShell')).toEqual(windows().map((w) => [w.hwnd]))
    for (const window of windows()) {
      expect(api.isTopmostWindow(window.hwnd)).toBe(false)
      expect(api.isAbove(window.hwnd, api.getShellWindow()!)).toBe(true)
      expect(api.guardMode(window.hwnd)).toBe('bottom')
      expect(window.webContents.sentOn('peek:changed')).toEqual([
        { peeking: true },
        { peeking: false }
      ])
    }
  })

  it('does nothing and emits nothing when the state does not change', () => {
    start()
    allReady()
    manager.peek(false)
    manager.peek(true)
    manager.peek(true)

    expect(api.callsTo('setTopmost')).toHaveLength(2)
    expect(windows()[0].webContents.sentOn('peek:changed')).toEqual([{ peeking: true }])
  })

  it('raises a window that becomes ready while peeking', () => {
    start()
    manager.peek(true)

    allReady()

    expect(windows().every((w) => api.isTopmostWindow(w.hwnd))).toBe(true)
  })

  it(`unpeeks after ${IDLE_UNPEEK_MS} ms without activity`, () => {
    start()
    allReady()
    manager.peek(true)

    vi.advanceTimersByTime(IDLE_UNPEEK_MS - 1)
    expect(manager.peeking).toBe(true)
    vi.advanceTimersByTime(1)
    expect(manager.peeking).toBe(false)
  })

  it('restarts the idle timer on activity', () => {
    start()
    manager.peek(true)

    vi.advanceTimersByTime(IDLE_UNPEEK_MS - 100)
    manager.noteActivity()
    vi.advanceTimersByTime(IDLE_UNPEEK_MS - 100)
    expect(manager.peeking).toBe(true)
    vi.advanceTimersByTime(100)
    expect(manager.peeking).toBe(false)
  })

  it('accepts an injected idle timeout', () => {
    start({ idleMs: 1000 })
    manager.peek(true)

    vi.advanceTimersByTime(1000)

    expect(manager.peeking).toBe(false)
  })

  it('a held peek ignores the idle timer until the hold is released', () => {
    start()
    allReady()
    manager.peek(true, { hold: 'inspector' })

    vi.advanceTimersByTime(IDLE_UNPEEK_MS * 3)
    expect(manager.peeking).toBe(true)

    manager.releaseHold('inspector')
    vi.advanceTimersByTime(IDLE_UNPEEK_MS - 1)
    expect(manager.peeking).toBe(true)
    vi.advanceTimersByTime(1)
    expect(manager.peeking).toBe(false)
  })

  it('adds a hold to a peek that is already on', () => {
    start()
    manager.peek(true)
    vi.advanceTimersByTime(IDLE_UNPEEK_MS - 1)

    manager.peek(true, { hold: 'inspector' })
    vi.advanceTimersByTime(IDLE_UNPEEK_MS * 2)

    expect(manager.peeking).toBe(true)
  })

  it('an explicit unpeek drops the holds', () => {
    start()
    manager.peek(true, { hold: 'inspector' })

    manager.peek(false)
    manager.peek(true)
    vi.advanceTimersByTime(IDLE_UNPEEK_MS)

    expect(manager.peeking).toBe(false)
  })

  it('pauses the idle timer while paused (for example while typing)', () => {
    start()
    manager.peek(true)

    manager.pauseIdle(true)
    vi.advanceTimersByTime(IDLE_UNPEEK_MS * 2)
    expect(manager.peeking).toBe(true)

    manager.pauseIdle(false)
    vi.advanceTimersByTime(IDLE_UNPEEK_MS)
    expect(manager.peeking).toBe(false)
  })
})

describe('z-order sentinel', () => {
  it('re-seats every window on a foreground event when the shell window is above them', () => {
    start()
    allReady()
    api.showDesktop()
    api.clearCalls()

    api.emitForeground(api.getShellWindow())

    expect(api.callsTo('seatAboveShell')).toEqual(windows().map((w) => [w.hwnd]))
    for (const window of windows()) {
      expect(api.isAbove(window.hwnd, api.getShellWindow()!)).toBe(true)
    }
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('re-seating after foreground'))
  })

  it('re-seats when Explorer restores an app window between a desktop window and the shell (Win+D undo)', () => {
    start()
    allReady()
    const [first] = windows()
    api.insertBelow(FAKE_APP_WINDOW, first.hwnd)
    expect(api.isAbove(first.hwnd, FAKE_APP_WINDOW)).toBe(true)
    api.clearCalls()

    api.emitForeground(FAKE_APP_WINDOW)

    expect(api.callsTo('seatAboveShell')).toEqual(windows().map((w) => [w.hwnd]))
    for (const window of windows()) expect(api.isAbove(FAKE_APP_WINDOW, window.hwnd)).toBe(true)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('re-seating after foreground'))
  })

  it('ignores hidden windows and its own desktop windows between a desktop window and the shell', () => {
    start()
    allReady()
    const [first, second] = windows()
    api.insertBelow(0x4444n, second.hwnd)
    api.hideWindow(0x4444n)
    expect(api.visibleWindowsBetween(first.hwnd, api.getShellWindow()!)).toContain(second.hwnd)
    api.clearCalls()

    vi.advanceTimersByTime(ZORDER_POLL_MS)

    expect(api.callsTo('seatAboveShell')).toEqual([])
  })

  it('leaves the windows alone on a foreground event when they are still seated', () => {
    start()
    allReady()
    api.clearCalls()

    api.emitForeground(0x1234n)

    expect(api.callsTo('seatAboveShell')).toEqual([])
  })

  it(`checks again ${FOREGROUND_SETTLE_MS} ms after a foreground change (Win+D raises the shell after activating it)`, () => {
    start()
    allReady()
    api.emitForeground(api.getShellWindow())
    api.showDesktop()
    api.clearCalls()

    vi.advanceTimersByTime(FOREGROUND_SETTLE_MS)

    expect(api.callsTo('seatAboveShell')).toEqual(windows().map((w) => [w.hwnd]))
  })

  it(`polls every ${ZORDER_POLL_MS} ms and re-seats above a new shell window after an Explorer restart`, () => {
    start()
    allReady()
    api.restartExplorer(null)
    vi.advanceTimersByTime(ZORDER_POLL_MS)
    api.restartExplorer(0x7777n)
    api.showDesktop()
    api.clearCalls()

    vi.advanceTimersByTime(ZORDER_POLL_MS)

    expect(api.callsTo('seatAboveShell')).toEqual(windows().map((w) => [w.hwnd]))
    for (const window of windows()) expect(api.isAbove(window.hwnd, 0x7777n)).toBe(true)
  })

  it('restores a window that was minimized or hidden', () => {
    start()
    allReady()
    const [first] = windows()
    first.minimized = true
    api.clearCalls()

    vi.advanceTimersByTime(ZORDER_POLL_MS)

    expect(first.minimized).toBe(false)
    expect(api.callsTo('seatAboveShell')).toEqual(windows().map((w) => [w.hwnd]))
  })

  it('does not fight a peek', () => {
    start()
    allReady()
    manager.peek(true, { hold: 'inspector' })
    api.showDesktop()
    api.clearCalls()

    api.emitForeground(api.getShellWindow())
    vi.advanceTimersByTime(ZORDER_POLL_MS)

    expect(api.callsTo('seatAboveShell')).toEqual([])
  })

  it('re-seats a window left topmost while not peeking', () => {
    start()
    allReady()
    const [first] = windows()
    api.forceTopmost(first.hwnd)
    api.clearCalls()

    vi.advanceTimersByTime(ZORDER_POLL_MS)

    expect(api.isTopmost(first.hwnd)).toBe(false)
    expect(api.isAbove(first.hwnd, api.getShellWindow()!)).toBe(true)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('topmost while not peeking'))
  })

  it('raises a peeking window that fell out of the topmost band', () => {
    start()
    allReady()
    manager.peek(true, { hold: 'inspector' })
    const [first] = windows()
    api.seatAboveShell(first.hwnd)
    api.clearCalls()

    vi.advanceTimersByTime(ZORDER_POLL_MS)

    expect(api.callsTo('setTopmost')).toContainEqual([first.hwnd, true])
    expect(api.isTopmost(first.hwnd)).toBe(true)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('not topmost while peeking'))
  })

  const reseats = (): number => api.callsTo('seatAboveShell').length / windows().length

  /** A poll-only fight: something displaces the windows before every poll, no foreground change. */
  function fightUntilBackOff(): void {
    for (let tick = 0; tick < 7; tick++) {
      api.showDesktop()
      vi.advanceTimersByTime(ZORDER_POLL_MS)
    }
  }

  it('backs off, doubling, from a poll-only fight (the foreground never changes), and warns once', () => {
    start()
    allReady()
    api.clearCalls()

    // 7 re-seats in 3.5 s: the 7th passes the limit (6 in 5 s) and starts a 2 s back-off.
    fightUntilBackOff()
    expect(reseats()).toBe(7)
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('another app may be fighting for the desktop layer')
    )

    api.showDesktop()
    vi.advanceTimersByTime(1_500)
    expect(reseats()).toBe(7)
    vi.advanceTimersByTime(500)
    expect(reseats()).toBe(8)

    // Still fighting: the next pause is 4 s.
    api.showDesktop()
    vi.advanceTimersByTime(3_500)
    expect(reseats()).toBe(8)
    vi.advanceTimersByTime(500)
    expect(reseats()).toBe(9)
    expect(log.warn).toHaveBeenCalledTimes(1)

    // Quiet for a full window: the episode ends.
    vi.advanceTimersByTime(10_000)
    expect(log.info).toHaveBeenCalledWith('zorder: settled; re-seat back-off reset')
  })

  it('repairs a Win+D at once even while the poll is backing off', () => {
    start()
    allReady()
    fightUntilBackOff()
    api.clearCalls()

    api.showDesktop()
    api.emitForeground(api.getShellWindow())

    expect(reseats()).toBe(1)
    for (const window of windows()) {
      expect(api.isAbove(window.hwnd, api.getShellWindow()!)).toBe(true)
    }
  })

  it('repairs through the 150 ms follow-up check even while the poll is backing off', () => {
    start()
    allReady()
    fightUntilBackOff()
    api.emitForeground(api.getShellWindow())
    api.showDesktop() // Win+D raises the shell after activating it
    api.clearCalls()

    vi.advanceTimersByTime(FOREGROUND_SETTLE_MS)

    expect(reseats()).toBe(1)
  })

  it('repairs every Win+D of a quick burst of toggles right away, without backing off', () => {
    start()
    allReady()
    api.clearCalls()

    for (let toggle = 0; toggle < 8; toggle++) {
      api.showDesktop()
      api.emitForeground(api.getShellWindow())
      expect(api.isAbove(windows()[0].hwnd, api.getShellWindow()!)).toBe(true)
      vi.advanceTimersByTime(300)
    }

    expect(reseats()).toBe(8)
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('fighting'))
    // Win+D right after the burst is still repaired immediately.
    api.showDesktop()
    api.emitForeground(api.getShellWindow())
    expect(reseats()).toBe(9)
  })

  it('bypasses the back-off for a new shell window that clean checks saw first, even after the grace period', () => {
    start()
    allReady()
    // A long poll-only fight: back-offs of 2, 4 and 8 s, then a 16 s one from t = 17.5 s.
    for (let step = 0; step < 35; step++) {
      api.showDesktop()
      vi.advanceTimersByTime(ZORDER_POLL_MS)
    }
    // Explorer restarts: the new shell window is created at the bottom and nothing (visible) is
    // displaced, so a foreground check and its follow-up find everything fine …
    api.hideWindow(FAKE_APP_WINDOW)
    api.restartExplorer(0x7777n)
    api.clearCalls()
    api.emitForeground(0x1234n)
    vi.advanceTimersByTime(FOREGROUND_SETTLE_MS)
    expect(reseats()).toBe(0)
    // … the grace period runs out while the 16 s back-off is still on …
    vi.advanceTimersByTime(SHELL_CHANGE_GRACE_MS + 1_500)
    // … and only now does the new shell window rise.
    api.showDesktop()
    api.clearCalls()

    vi.advanceTimersByTime(ZORDER_POLL_MS)

    expect(reseats()).toBe(1)
    for (const window of windows()) expect(api.isAbove(window.hwnd, 0x7777n)).toBe(true)
  })

  it(`keeps bypassing the back-off for ${SHELL_CHANGE_GRACE_MS / 1000} s after a new shell window appeared`, () => {
    start()
    allReady()
    fightUntilBackOff()
    // The foreground check re-seats against the new shell window once (an app window was left
    // below it) …
    api.restartExplorer(0x7777n)
    api.emitForeground(0x1234n)
    vi.advanceTimersByTime(FOREGROUND_SETTLE_MS)
    // … and the new shell window rises again while Explorer is still starting up.
    api.showDesktop()
    api.clearCalls()

    vi.advanceTimersByTime(ZORDER_POLL_MS)

    expect(reseats()).toBe(1)
  })

  it('re-seats above a new shell window after an Explorer restart even while backing off', () => {
    start()
    allReady()
    fightUntilBackOff()
    api.restartExplorer(0x7777n)
    api.showDesktop()
    api.clearCalls()

    vi.advanceTimersByTime(ZORDER_POLL_MS)

    expect(reseats()).toBe(1)
    for (const window of windows()) expect(api.isAbove(window.hwnd, 0x7777n)).toBe(true)
  })

  it('stops polling and unhooks the foreground watch on dispose', () => {
    start()
    allReady()
    expect(api.foregroundListenerCount()).toBe(1)

    manager.dispose()
    api.showDesktop()
    api.clearCalls()
    vi.advanceTimersByTime(ZORDER_POLL_MS * 4)

    expect(api.foregroundListenerCount()).toBe(0)
    expect(api.calls).toEqual([])
  })

  it('keeps working on the poll alone when the foreground hook cannot be installed', () => {
    api.watchForeground = () => {
      throw new Error('SetWinEventHook failed')
    }
    start()
    allReady()
    api.showDesktop()
    api.clearCalls()

    vi.advanceTimersByTime(ZORDER_POLL_MS)

    expect(api.callsTo('seatAboveShell')).toHaveLength(2)
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('foreground hook unavailable'),
      expect.any(Error)
    )
  })
})

describe('display changes', () => {
  const THIRD = fakeDisplay(77, { x: -1920, y: 0, width: 1920, height: 1080 }, 1.25)

  it('opens a window for an added display and tells every window display:changed', () => {
    start()
    allReady()

    electron.screen.addDisplay(THIRD)

    expect(live()).toHaveLength(3)
    expect(live()[2].loads[0].query).toEqual({ displayId: '77' })
    expect(live()[0].webContents.sentOn('display:changed')).toEqual([
      expect.objectContaining({ id: PRIMARY_DISPLAY.id })
    ])
    expect(live()[2].webContents.sentOn('display:changed')).toEqual([
      expect.objectContaining({ id: 77, scaleFactor: 1.25 })
    ])
  })

  it('closes the window of a removed display', () => {
    start()
    allReady()
    const [, second] = windows()

    electron.screen.removeDisplay(SECONDARY_DISPLAY.id)

    expect(second.destroyed).toBe(true)
    expect(api.guardMode(second.hwnd)).toBeNull()
    expect(manager.windows().map((w) => w.displayId)).toEqual([PRIMARY_DISPLAY.id])
    expect(manager.getDisplay(SECONDARY_DISPLAY.id)).toBeNull()
  })

  it('moves a window when its display metrics change and re-delivers them', () => {
    start()
    allReady()
    const resized = {
      ...SECONDARY_DISPLAY,
      scaleFactor: 2,
      workArea: { ...SECONDARY_DISPLAY.workArea }
    }

    electron.screen.changeDisplay(resized, ['scaleFactor'])

    expect(windows()[1].bounds).toEqual({ x: 2560, y: 0, width: 1920, height: 1079 })
    expect(windows()[1].webContents.sentOn('display:changed')).toEqual([
      expect.objectContaining({ id: SECONDARY_DISPLAY.id, scaleFactor: 2 })
    ])
  })

  it('never closes the last window while displays are swapped', () => {
    const only = fakeDisplay(1, { x: 0, y: 0, width: 1920, height: 1080 })
    electron = createFakeElectron([only])
    start()
    const replacement = fakeDisplay(2, { x: 0, y: 0, width: 2560, height: 1440 })

    electron.screen.displays = [replacement]
    electron.screen.emit('display-removed', {}, only)

    expect(windows()[1].destroyed).toBe(false)
    expect(windows()[0].destroyed).toBe(true)
    expect(manager.windows().map((w) => w.displayId)).toEqual([2])
  })

  it('re-sends display and peek state when a renderer (re)loads', () => {
    start()
    allReady()
    manager.peek(true, { hold: 'inspector' })
    const [first] = windows()
    first.webContents.sent.length = 0

    first.webContents.emit('did-finish-load')

    expect(first.webContents.sent).toEqual([
      { channel: 'display:changed', payload: expect.objectContaining({ id: PRIMARY_DISPLAY.id }) },
      { channel: 'peek:changed', payload: { peeking: true } }
    ])
  })

  it('treats a WM_CLOSE from outside as a request to quit the whole app gracefully', () => {
    start()
    allReady()

    windows()[0].close()

    expect(windows()[0].destroyed).toBe(false)
    expect(requestQuit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(requestQuit).toHaveBeenCalledOnce()
    expect(log.info).toHaveBeenCalledWith(
      `desktop: close requested for display ${PRIMARY_DISPLAY.id} from outside; quitting the app`
    )
  })

  it('does not ask to quit again when the app is already quitting', () => {
    start()
    allReady()
    windows()[0].close()
    manager.prepareToQuit()

    vi.advanceTimersByTime(0)

    expect(requestQuit).not.toHaveBeenCalled()
  })

  it('recreates a window destroyed from outside on a later tick, never inside closed', () => {
    start()
    allReady()
    const [first] = windows()

    first.destroy()
    expect(live()).toHaveLength(1)
    vi.advanceTimersByTime(0)

    expect(live()).toHaveLength(2)
    const replacement = live().find((w) => w !== windows()[1])!
    expect(replacement).not.toBe(first)
    expect(replacement.loads[0].query).toEqual({ displayId: String(PRIMARY_DISPLAY.id) })
    expect(
      manager
        .windows()
        .map((w) => w.displayId)
        .sort()
    ).toEqual([PRIMARY_DISPLAY.id, SECONDARY_DISPLAY.id].sort())
    expect(log.warn).toHaveBeenCalledWith(
      `desktop: the window on display ${PRIMARY_DISPLAY.id} was destroyed; recreating it`
    )
  })

  it(`retries a capped display once more after ${RECREATE_COOLDOWN_MS / 60_000} min`, () => {
    start()
    allReady()
    const primaryWindow = (): FakeBrowserWindow | undefined =>
      live().find((w) => w.loads[0].query?.displayId === String(PRIMARY_DISPLAY.id))
    for (let round = 0; round <= RECREATE_LIMIT; round++) {
      primaryWindow()!.destroy()
      vi.advanceTimersByTime(0)
    }
    expect(primaryWindow()).toBeUndefined()

    vi.advanceTimersByTime(RECREATE_COOLDOWN_MS - 1)
    expect(primaryWindow()).toBeUndefined()
    vi.advanceTimersByTime(1)

    expect(primaryWindow()).toBeDefined()
    expect(log.info).toHaveBeenCalledWith(
      `desktop: retrying the window on display ${PRIMARY_DISPLAY.id} after a ${RECREATE_COOLDOWN_MS / 60_000} min pause`
    )
  })

  it('does not recreate a window when the app starts quitting before the next tick', () => {
    start()
    allReady()

    windows()[0].destroy()
    manager.prepareToQuit()
    vi.advanceTimersByTime(0)

    expect(live()).toHaveLength(1)
  })

  it(`stops recreating a display's window after ${RECREATE_LIMIT} recreations in ${RECREATE_WINDOW_MS / 1000} s`, () => {
    start()
    allReady()
    const primaryWindow = (): FakeBrowserWindow =>
      live().find((w) => w.loads[0].query?.displayId === String(PRIMARY_DISPLAY.id))!

    for (let round = 0; round < RECREATE_LIMIT; round++) {
      primaryWindow().destroy()
      vi.advanceTimersByTime(0)
    }
    expect(live()).toHaveLength(2)

    primaryWindow().destroy()
    vi.advanceTimersByTime(0)

    expect(live()).toHaveLength(1)
    expect(log.error).toHaveBeenCalledWith(
      `desktop: the window on display ${PRIMARY_DISPLAY.id} was destroyed ${RECREATE_LIMIT + 1} times in ${RECREATE_WINDOW_MS / 1000} s; not recreating it`
    )
  })

  it('does not recreate a window whose display is gone', () => {
    start()
    allReady()
    electron.screen.displays = [SECONDARY_DISPLAY]

    windows()[0].destroy()

    expect(live()).toHaveLength(1)
  })

  it('lets every window close, and recreates none, once the app is quitting', () => {
    start()
    allReady()

    manager.prepareToQuit()
    for (const window of windows()) window.close()

    expect(manager.quitting).toBe(true)
    expect(live()).toHaveLength(0)
    expect(manager.windows()).toHaveLength(0)
  })
})

describe('power and session', () => {
  it('keeps the poll off until both the lock and the sleep are over, re-seating on each wake', () => {
    start()
    allReady()

    electron.powerMonitor.emit('lock-screen')
    electron.powerMonitor.emit('suspend')
    api.clearCalls()
    electron.powerMonitor.emit('resume')
    expect(reseatCount()).toBe(1)

    api.showDesktop()
    api.clearCalls()
    vi.advanceTimersByTime(ZORDER_POLL_MS * 4)
    expect(api.calls).toEqual([])

    electron.powerMonitor.emit('unlock-screen')
    expect(reseatCount()).toBe(1)
    api.showDesktop()
    api.clearCalls()
    vi.advanceTimersByTime(ZORDER_POLL_MS)
    expect(reseatCount()).toBe(1)
  })

  it.each([
    ['lock-screen', 'unlock-screen'],
    ['suspend', 'resume']
  ])('pauses the sentinel on %s and re-seats on %s', (pause, wake) => {
    start()
    allReady()

    electron.powerMonitor.emit(pause)
    api.showDesktop()
    api.emitForeground(api.getShellWindow())
    api.clearCalls()
    vi.advanceTimersByTime(ZORDER_POLL_MS * 4)
    expect(api.callsTo('seatAboveShell')).toEqual([])
    expect(api.calls).toEqual([])

    electron.powerMonitor.emit(wake)
    expect(api.callsTo('seatAboveShell')).toEqual(windows().map((w) => [w.hwnd]))

    api.showDesktop()
    api.clearCalls()
    vi.advanceTimersByTime(ZORDER_POLL_MS)
    expect(api.callsTo('seatAboveShell')).toEqual(windows().map((w) => [w.hwnd]))
  })
})
