import type { ElectronApplication } from '@playwright/test'
import type { Rectangle } from 'electron'
import type { Hwnd } from '../../src/main/win32/api'
import { WS_EX_APPWINDOW, WS_EX_TOOLWINDOW } from '../../src/main/win32/constants'
import { createKoffiWin32Api } from '../../src/main/win32/koffi-api'
import { sleepSync } from '../../scripts/lib/sleep-sync'
import { loadScriptWin32 } from '../../scripts/lib/win32-script'

/** How long a synthesized click may take to make its window the foreground window. */
const CLICK_FOCUS_TIMEOUT_MS = 1_000

export interface DesktopWindowInfo {
  hwnd: Hwnd
  displayId: number
  bounds: Rectangle
  /** `bounds` in physical pixels (`screen.dipToScreenRect`): what `GetWindowRect` must return. */
  screenBounds: Rectangle
}

/** How long a just-created window may take to start navigating to its renderer URL. */
const URL_WAIT_MS = 10_000

/**
 * Each Taskyard window's HWND, bounds and the displayId its renderer URL carries. Waits until
 * every window has started loading: right after the windows open, getURL() is still empty.
 */
export async function desktopWindowInfo(app: ElectronApplication): Promise<DesktopWindowInfo[]> {
  const read = (): Promise<
    { hwnd: string; url: string; bounds: Rectangle; screenBounds: Rectangle }[]
  > =>
    app.evaluate(({ BrowserWindow, screen }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        // HWNDs cross the Playwright bridge as strings: BigInt is not serializable.
        hwnd: window.getNativeWindowHandle().readBigUInt64LE(0).toString(),
        url: window.webContents.getURL(),
        bounds: window.getBounds(),
        screenBounds: screen.dipToScreenRect(window, window.getBounds())
      }))
    )
  const deadline = Date.now() + URL_WAIT_MS
  let windows = await read()
  while (windows.some((window) => window.url === '') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    windows = await read()
  }
  return windows.map((window) => ({
    hwnd: BigInt(window.hwnd),
    displayId: Number(new URL(window.url).searchParams.get('displayId')),
    bounds: window.bounds,
    screenBounds: window.screenBounds
  }))
}

export interface Win32Probe {
  WS_EX_TOOLWINDOW: number
  WS_EX_APPWINDOW: number
  exStyle(hwnd: Hwnd): number
  isVisible(hwnd: Hwnd): boolean
  isIconic(hwnd: Hwnd): boolean
  /** `GetWindowRect` in physical pixels (this process is made per-monitor DPI aware). */
  windowRect(hwnd: Hwnd): Rectangle
  /** Above the shell desktop window in the z-order (the brief's `isAbove(taskyard, shell)`). */
  isSeated(hwnd: Hwnd): boolean
  /** A screen point where `hwnd` is the top-level window under the cursor, or null. */
  uncoveredPoint(hwnd: Hwnd): { x: number; y: number } | null
  /** The composed screen colour at a point, as 0xRRGGBB. */
  screenPixel(x: number, y: number): number
  /** Posts WM_CLOSE, as taskkill (without /F) or an installer would. */
  postClose(hwnd: Hwnd): void
  /**
   * Makes `hwnd` the foreground window, then presses Alt+F4 for real. Presses nothing (and
   * returns false) when `hwnd` could not be made foreground: the keys would reach the user's app.
   */
  altF4(hwnd: Hwnd): boolean
  /** Like altF4, with Ctrl+<letter>. */
  ctrl(hwnd: Hwnd, letter: string): boolean
  foregroundWindow(): Hwnd | null
}

/** Reads another process's windows through the app's koffi layer and the script helpers. */
export async function win32Probe(): Promise<Win32Probe> {
  const koffi = (await import('koffi')).default
  const api = createKoffiWin32Api(koffi, { log: console })
  const win32 = loadScriptWin32(koffi)
  // Physical-pixel rects regardless of display scaling.
  win32.makeDpiAware()

  /**
   * SetForegroundWindow (with the Alt trick) first. Windows refuses it while the foreground lock
   * is held (e.g. by a cloaked shell flyout such as Search), so fall back to a real click on a
   * spot of `hwnd` that no other window covers: a click on our own window, nowhere else.
   */
  const focus = (hwnd: Hwnd): boolean => {
    if (win32.setForeground(hwnd)) return true
    const point = win32.uncoveredPoint(hwnd)
    if (point === null) return false
    const cursor = win32.cursor()
    win32.clickAt(point.x, point.y)
    // The click is processed asynchronously at the cursor position: move the cursor back only
    // once it has landed, or it would land wherever the cursor went.
    const deadline = Date.now() + CLICK_FOCUS_TIMEOUT_MS
    while (win32.foregroundWindow() !== hwnd && Date.now() < deadline) sleepSync(25)
    win32.moveCursor(cursor.x, cursor.y)
    return win32.foregroundWindow() === hwnd
  }

  return {
    WS_EX_TOOLWINDOW,
    WS_EX_APPWINDOW,
    exStyle: (hwnd) => win32.exStyleOf(hwnd),
    isVisible: (hwnd) => win32.isVisible(hwnd),
    isIconic: (hwnd) => win32.isIconic(hwnd),
    windowRect(hwnd) {
      const r = win32.rectOf(hwnd)
      return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
    },
    uncoveredPoint: (hwnd) => win32.uncoveredPoint(hwnd),
    screenPixel: (x, y) => win32.screenPixel(x, y),
    postClose: (hwnd) => win32.postClose(hwnd),
    altF4(hwnd) {
      const focused = focus(hwnd)
      if (focused) win32.pressAltF4()
      return focused
    },
    ctrl(hwnd, letter) {
      const focused = focus(hwnd)
      if (focused) win32.pressCtrl(letter.toUpperCase().charCodeAt(0))
      return focused
    },
    foregroundWindow: () => win32.foregroundWindow(),
    isSeated: (hwnd) => {
      const shell = api.getShellWindow()
      return shell !== null && api.isAbove(hwnd, shell)
    }
  }
}
