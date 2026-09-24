import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_NAME } from '@shared/app-info'
import type { ZOrderMode } from '../win32/api'
import { createFakeWin32Api, type FakeWin32Api } from '../win32/fake-api'
import {
  createFakeElectron,
  FakeBrowserWindow,
  PRIMARY_DISPLAY,
  recordShowOrder,
  SECONDARY_DISPLAY
} from '../test/fake-electron'
import { secureWebPreferences } from './window-options'
import {
  CRASH_RELOAD_LIMIT,
  CRASH_RELOAD_WINDOW_MS,
  CRASH_RETRY_COOLDOWN_MS,
  createDesktopWindow,
  READY_TO_SHOW_TIMEOUT_MS,
  desktopWindowBounds,
  desktopWindowOptions,
  desktopWindowUrl,
  hwndFromHandle,
  type DesktopWindowDeps
} from './desktop-window'

const PRELOAD = 'C:\\app\\out\\preload\\index.js'
const INDEX_HTML = 'C:\\app\\out\\renderer\\index.html'

describe('desktopWindowBounds', () => {
  it('covers the display but stays 1 px short of its bottom edge', () => {
    expect(desktopWindowBounds(SECONDARY_DISPLAY)).toEqual({
      x: 2560,
      y: 0,
      width: 1920,
      height: 1079
    })
  })
})

describe('desktopWindowOptions', () => {
  it('builds an opaque, frameless, fixed, non-minimizable toolbar window', () => {
    const options = desktopWindowOptions(PRIMARY_DISPLAY, PRELOAD)

    expect(options).toMatchObject({
      title: APP_NAME,
      x: 0,
      y: 0,
      width: 2560,
      height: 1439,
      frame: false,
      transparent: false,
      backgroundColor: '#000000',
      roundedCorners: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      type: 'toolbar',
      show: false,
      focusable: true
    })
  })

  it('drops the thick frame, so the real window rect keeps the 1 px bottom inset', () => {
    // With Electron's default thickFrame the HWND keeps WS_CAPTION and invisible 8 px borders:
    // measured [-8,0 2576x1447] on a 2560x1440 monitor, which the shell treats as full screen.
    expect(desktopWindowOptions(PRIMARY_DISPLAY, PRELOAD).thickFrame).toBe(false)
  })

  it('keeps the secure renderer, never throttles it and passes the display id', () => {
    const { webPreferences } = desktopWindowOptions(PRIMARY_DISPLAY, PRELOAD)

    expect(webPreferences).toEqual({
      ...secureWebPreferences(PRELOAD),
      backgroundThrottling: false,
      additionalArguments: ['--display-id=2450156880']
    })
  })
})

describe('desktopWindowUrl', () => {
  it('adds displayId to the dev-server URL', () => {
    expect(desktopWindowUrl('http://localhost:5173/', 42)).toBe(
      'http://localhost:5173/?displayId=42'
    )
    expect(desktopWindowUrl('http://localhost:5173/?x=1', 42)).toBe(
      'http://localhost:5173/?x=1&displayId=42'
    )
  })
})

describe('hwndFromHandle', () => {
  it('reads a 64-bit HWND buffer', () => {
    const handle = Buffer.alloc(8)
    handle.writeBigUInt64LE(0x1234abcdn)
    expect(hwndFromHandle(handle)).toBe(0x1234abcdn)
  })

  it('reads a 32-bit HWND buffer', () => {
    const handle = Buffer.alloc(4)
    handle.writeUInt32LE(0x2468)
    expect(hwndFromHandle(handle)).toBe(0x2468n)
  })
})

describe('createDesktopWindow', () => {
  let api: FakeWin32Api
  let mode: ZOrderMode
  let deps: DesktopWindowDeps & {
    onClosed: ReturnType<typeof vi.fn>
    onCloseRequest: ReturnType<typeof vi.fn>
  }
  let quitting: boolean
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn(), debug: vi.fn() }

  beforeEach(() => {
    vi.useFakeTimers()
    const electron = createFakeElectron()
    api = createFakeWin32Api()
    mode = 'bottom'
    quitting = false
    deps = {
      BrowserWindow: electron.BrowserWindow,
      api,
      preloadPath: PRELOAD,
      renderer: { kind: 'file', path: INDEX_HTML },
      log,
      mode: () => mode,
      canClose: () => quitting,
      onClosed: vi.fn(),
      onCloseRequest: vi.fn()
    }
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const only = (): FakeBrowserWindow => {
    expect(FakeBrowserWindow.instances).toHaveLength(1)
    return FakeBrowserWindow.instances[0]
  }

  it('loads index.html with the displayId query', () => {
    createDesktopWindow(SECONDARY_DISPLAY, deps)

    expect(only().loads).toEqual([
      { kind: 'file', target: INDEX_HTML, query: { displayId: '1529295726' } }
    ])
  })

  it('loads the dev-server URL with displayId', () => {
    createDesktopWindow(SECONDARY_DISPLAY, {
      ...deps,
      renderer: { kind: 'url', url: 'http://localhost:5173/' }
    })

    expect(only().loads).toEqual([
      { kind: 'url', target: 'http://localhost:5173/?displayId=1529295726' }
    ])
  })

  it('has no menu, so no Ctrl+W / Ctrl+R / Ctrl+Shift+I / Ctrl+M accelerators', () => {
    createDesktopWindow(PRIMARY_DISPLAY, deps)

    expect(only().menuRemoved).toBe(true)
  })

  it('swallows Alt+F4 and Ctrl+W before the page or any menu sees them', () => {
    createDesktopWindow(PRIMARY_DISPLAY, deps)
    const { webContents } = only()

    expect(webContents.pressKey({ key: 'F4', alt: true })).toBe(true)
    expect(webContents.pressKey({ key: 'w', control: true })).toBe(true)
    expect(webContents.pressKey({ key: 'W', control: true, shift: true })).toBe(true)
    expect(webContents.pressKey({ key: 'F4' })).toBe(false)
    expect(webContents.pressKey({ key: 'w' })).toBe(false)
    expect(webContents.pressKey({ key: 'a', control: true })).toBe(false)
    expect(webContents.pressKey({ key: 'F4', alt: true, type: 'keyUp' })).toBe(false)
  })

  it('does not open DevTools on F12 unless DevTools are enabled (packaged builds)', () => {
    createDesktopWindow(PRIMARY_DISPLAY, deps)
    const { webContents } = only()

    expect(webContents.pressKey({ key: 'F12' })).toBe(false)
    expect(webContents.devTools).toEqual([])
  })

  it('toggles detached DevTools on F12 when enabled (dev builds), still blocking Alt+F4 and Ctrl+W', () => {
    createDesktopWindow(PRIMARY_DISPLAY, { ...deps, devTools: true })
    const { webContents } = only()

    expect(webContents.pressKey({ key: 'F12' })).toBe(true)
    expect(webContents.devTools).toEqual([{ open: 'detach' }])
    expect(webContents.pressKey({ key: 'F12' })).toBe(true)
    expect(webContents.devTools).toEqual([{ open: 'detach' }, 'close'])
    // Only a plain F12 key-down; a key-up or a modified F12 stays the page's.
    expect(webContents.pressKey({ key: 'F12', type: 'keyUp' })).toBe(false)
    expect(webContents.pressKey({ key: 'F12', control: true })).toBe(false)
    expect(webContents.devTools).toHaveLength(2)
    expect(webContents.pressKey({ key: 'F4', alt: true })).toBe(true)
    expect(webContents.pressKey({ key: 'w', control: true })).toBe(true)
  })

  it('leaves a page its beforeunload veto while nothing is closing the window', () => {
    createDesktopWindow(PRIMARY_DISPLAY, deps)

    expect(only().webContents.tryToBlockUnload()).toBe(false)
  })

  it('overrides a beforeunload veto (will-prevent-unload) once the app is quitting', () => {
    createDesktopWindow(PRIMARY_DISPLAY, deps)
    quitting = true

    expect(only().webContents.tryToBlockUnload()).toBe(true)
    expect(log.info).toHaveBeenCalledWith(
      `desktop: ignored the page's beforeunload on display ${PRIMARY_DISPLAY.id} (closing)`
    )
  })

  it('overrides a beforeunload veto when its owner closes it (display removed)', () => {
    const desktop = createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()
    // The page's veto arrives while the close is under way.
    window.on('close', () => {
      expect(window.webContents.tryToBlockUnload()).toBe(true)
    })

    desktop.close()

    expect(window.destroyed).toBe(true)
  })

  it('destroys the half-built window and rethrows when setting it up fails', () => {
    const failing = class extends FakeBrowserWindow {
      override removeMenu(): void {
        throw new Error('menu gone')
      }
    }

    expect(() => createDesktopWindow(PRIMARY_DISPLAY, { ...deps, BrowserWindow: failing })).toThrow(
      'menu gone'
    )
    expect(only().destroyed).toBe(true)
    expect(deps.onClosed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-applies its bounds after creation, since Chromium clamps a new window to the work area', () => {
    createDesktopWindow(SECONDARY_DISPLAY, deps)

    expect(only().boundsSet).toEqual([{ x: 2560, y: 0, width: 1920, height: 1079 }])
  })

  it('stays hidden and unseated until ready-to-show', () => {
    const desktop = createDesktopWindow(PRIMARY_DISPLAY, deps)

    expect(desktop.ready).toBe(false)
    expect(api.calls).toEqual([])
  })

  it('shows without activation, seats above the shell, then installs the guard', () => {
    const order = recordShowOrder(api)
    const desktop = createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()

    window.becomeReady()

    expect(desktop.hwnd).toBe(window.hwnd)
    expect(desktop.ready).toBe(true)
    // Electron's showInactive(), not a raw ShowWindow: Chromium only paints a window it showed
    // itself (measured: raw SW_SHOWNOACTIVATE left the screen black, showInactive painted).
    expect(order).toEqual([
      `showInactive ${window.hwnd}`,
      `seatAboveShell ${window.hwnd}`,
      `installZOrderGuard ${window.hwnd}`
    ])
    expect(window.visible).toBe(true)
    expect(api.callsTo('showNoActivate')).toEqual([])
    expect(api.isAbove(window.hwnd, api.getShellWindow()!)).toBe(true)
    expect(api.guardMode(window.hwnd)).toBe('bottom')
    mode = 'peek'
    expect(api.guardMode(window.hwnd)).toBe('peek')
  })

  it('re-seats on focus, show and restore', () => {
    createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()
    window.becomeReady()

    for (const event of ['focus', 'show', 'restore']) {
      api.clearCalls()
      window.emit(event)
      expect(api.callsTo('seatAboveShell'), event).toEqual([[window.hwnd]])
    }
  })

  it('raises instead of seating while peeking', () => {
    const desktop = createDesktopWindow(PRIMARY_DISPLAY, deps)
    only().becomeReady()
    mode = 'peek'
    api.clearCalls()

    desktop.reseat()

    expect(api.callsTo('setTopmost')).toEqual([[desktop.hwnd, true]])
    expect(api.callsTo('seatAboveShell')).toEqual([])
  })

  it('un-minimizes without activation before re-seating', () => {
    const desktop = createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()
    window.becomeReady()
    window.minimized = true
    api.clearCalls()
    const order = recordShowOrder(api)

    window.emit('minimize')

    expect(order).toEqual([`showInactive ${window.hwnd}`, `seatAboveShell ${window.hwnd}`])
    expect(window.minimized).toBe(false)
    expect(api.callsTo('seatAboveShell')).toEqual([[desktop.hwnd]])
  })

  it('reports whether it was minimized or hidden', () => {
    const desktop = createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()
    window.becomeReady()
    window.visible = true
    expect(desktop.displaced()).toBe(false)

    window.minimized = true
    expect(desktop.displaced()).toBe(true)
    window.minimized = false
    window.visible = false
    expect(desktop.displaced()).toBe(true)
  })

  it('moves to new display bounds, keeping the 1 px bottom inset', () => {
    const desktop = createDesktopWindow(PRIMARY_DISPLAY, deps)

    desktop.setDisplay({ ...PRIMARY_DISPLAY, bounds: { x: 0, y: 0, width: 1920, height: 1080 } })

    expect(only().boundsSet.at(-1)).toEqual({ x: 0, y: 0, width: 1920, height: 1079 })
  })

  it('closes when its owner closes it (display removed), removing the guard', () => {
    const desktop = createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()
    window.becomeReady()

    desktop.close()

    expect(window.destroyed).toBe(true)
    expect(api.callsTo('removeZOrderGuard')).toEqual([[window.hwnd]])
    expect(api.guardMode(window.hwnd)).toBeNull()
    expect(deps.onClosed).toHaveBeenCalledExactlyOnceWith(desktop, { expected: true })
    expect(desktop.ready).toBe(false)
  })

  it('keeps the window on an outside close (WM_CLOSE) and asks its owner to quit the app instead', () => {
    const desktop = createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()
    window.becomeReady()

    window.close()

    expect(window.destroyed).toBe(false)
    expect(desktop.ready).toBe(true)
    expect(api.guardMode(window.hwnd)).toBe('bottom')
    expect(deps.onClosed).not.toHaveBeenCalled()
    expect(deps.onCloseRequest).toHaveBeenCalledExactlyOnceWith(desktop)
  })

  it('closes when the app is quitting', () => {
    createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()
    window.becomeReady()
    quitting = true

    window.close()

    expect(window.destroyed).toBe(true)
    expect(api.guardMode(window.hwnd)).toBeNull()
    expect(deps.onClosed).toHaveBeenCalledWith(expect.anything(), { expected: true })
  })

  it('lets Windows close it when the session ends (log off, shutdown)', () => {
    createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()
    window.becomeReady()

    window.emit('session-end')
    window.close()

    expect(window.destroyed).toBe(true)
  })

  it('reports a window destroyed without a close as unexpected, and drops its guard', () => {
    const desktop = createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()
    window.becomeReady()

    window.destroy()

    expect(deps.onClosed).toHaveBeenCalledExactlyOnceWith(desktop, { expected: false })
    expect(api.guardMode(window.hwnd)).toBeNull()
  })

  it(`shows and seats the window anyway when ready-to-show has not fired after ${READY_TO_SHOW_TIMEOUT_MS} ms`, () => {
    const order = recordShowOrder(api)
    const desktop = createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()

    vi.advanceTimersByTime(READY_TO_SHOW_TIMEOUT_MS - 1)
    expect(desktop.ready).toBe(false)
    vi.advanceTimersByTime(1)

    expect(desktop.ready).toBe(true)
    expect(order).toEqual([
      `showInactive ${window.hwnd}`,
      `seatAboveShell ${window.hwnd}`,
      `installZOrderGuard ${window.hwnd}`
    ])
    expect(log.warn).toHaveBeenCalledWith(
      `desktop: no ready-to-show on display ${PRIMARY_DISPLAY.id} after ${READY_TO_SHOW_TIMEOUT_MS} ms; showing anyway`
    )
    window.becomeReady()
    expect(order).toHaveLength(3)
  })

  it('does not fire the ready-to-show fallback once the window showed normally', () => {
    createDesktopWindow(PRIMARY_DISPLAY, deps)
    only().becomeReady()
    api.clearCalls()

    vi.advanceTimersByTime(READY_TO_SHOW_TIMEOUT_MS * 2)

    expect(api.calls).toEqual([])
  })

  it(`reloads a crashed renderer, at most ${CRASH_RELOAD_LIMIT} times in ${CRASH_RELOAD_WINDOW_MS / 1000} s`, () => {
    createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()
    window.becomeReady()
    const { webContents } = window
    const crash = (): void => {
      webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    }

    for (let index = 0; index < CRASH_RELOAD_LIMIT; index++) crash()

    expect(webContents.reloads).toBe(CRASH_RELOAD_LIMIT)
    expect(window.visible).toBe(true)
  })

  it(`hides a window whose renderer keeps crashing, then retries once after ${CRASH_RETRY_COOLDOWN_MS / 60_000} min`, () => {
    const desktop = createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()
    window.becomeReady()
    window.visible = true
    const { webContents } = window
    const crash = (): void => {
      webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    }
    for (let index = 0; index <= CRASH_RELOAD_LIMIT; index++) crash()

    // Given up: hidden, so Explorer's own desktop shows instead of a dead black rectangle.
    expect(webContents.reloads).toBe(CRASH_RELOAD_LIMIT)
    expect(window.visible).toBe(false)
    expect(desktop.ready).toBe(false)
    expect(log.error).toHaveBeenCalledWith(
      `desktop: renderer on display ${PRIMARY_DISPLAY.id} keeps crashing (${CRASH_RELOAD_LIMIT} reloads in ${CRASH_RELOAD_WINDOW_MS / 1000} s); hiding the window, retrying in ${CRASH_RETRY_COOLDOWN_MS / 60_000} min`
    )
    desktop.reseat()
    expect(window.visible).toBe(false)

    vi.advanceTimersByTime(CRASH_RETRY_COOLDOWN_MS - 1)
    expect(webContents.reloads).toBe(CRASH_RELOAD_LIMIT)
    vi.advanceTimersByTime(1)
    expect(webContents.reloads).toBe(CRASH_RELOAD_LIMIT + 1)

    // The retry loaded: shown and seated again.
    api.clearCalls()
    webContents.emit('did-finish-load')
    expect(window.visible).toBe(true)
    expect(desktop.ready).toBe(true)
    expect(api.callsTo('seatAboveShell')).toEqual([[window.hwnd]])
  })

  it('never shows a window whose renderer crash-loops before its first paint, until a retry loads', () => {
    const desktop = createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()
    const { webContents } = window
    for (let index = 0; index <= CRASH_RELOAD_LIMIT; index++) {
      webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    }

    // Neither the ready-to-show fallback nor a late ready-to-show shows the dead window.
    vi.advanceTimersByTime(READY_TO_SHOW_TIMEOUT_MS)
    window.becomeReady()
    expect(window.visible).toBe(false)
    expect(desktop.ready).toBe(false)
    expect(api.callsTo('installZOrderGuard')).toEqual([])

    vi.advanceTimersByTime(CRASH_RETRY_COOLDOWN_MS)
    webContents.emit('did-finish-load')
    expect(window.visible).toBe(true)
    expect(desktop.ready).toBe(true)
  })

  it('gives up again at once when the retry crashes too, and waits another cool-down', () => {
    createDesktopWindow(PRIMARY_DISPLAY, deps)
    const window = only()
    window.becomeReady()
    const { webContents } = window
    const crash = (): void => {
      webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    }
    for (let index = 0; index <= CRASH_RELOAD_LIMIT; index++) crash()
    vi.advanceTimersByTime(CRASH_RETRY_COOLDOWN_MS)
    const afterRetry = webContents.reloads

    crash()

    expect(webContents.reloads).toBe(afterRetry)
    expect(window.visible).toBe(false)
    vi.advanceTimersByTime(CRASH_RETRY_COOLDOWN_MS)
    expect(webContents.reloads).toBe(afterRetry + 1)
  })

  it('logs and keeps running when the guard cannot be installed', () => {
    api.installZOrderGuard = () => false
    createDesktopWindow(PRIMARY_DISPLAY, deps)

    only().becomeReady()

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('z-order guard not installed'))
  })

  it('denies window.open and logs renderer crashes', () => {
    createDesktopWindow(PRIMARY_DISPLAY, deps)
    const { webContents } = only()

    expect(webContents.windowOpenHandler?.()).toEqual({ action: 'deny' })
    webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('renderer process gone'), {
      reason: 'crashed'
    })
  })
})
