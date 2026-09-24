import type { ElectronApplication } from '@playwright/test'
import type { Rectangle } from 'electron'
import type { Hwnd } from '../../src/main/win32/api'
import { WS_EX_APPWINDOW, WS_EX_TOOLWINDOW } from '../../src/main/win32/constants'
import { createKoffiWin32Api } from '../../src/main/win32/koffi-api'
import { loadScriptWin32 } from '../../scripts/lib/win32-script'

export interface DesktopWindowInfo {
  hwnd: Hwnd
  displayId: number
  bounds: Rectangle
  /** `bounds` in physical pixels (`screen.dipToScreenRect`): what `GetWindowRect` must return. */
  screenBounds: Rectangle
}

/** Each Taskyard window's HWND, bounds and the displayId its renderer URL carries. */
export async function desktopWindowInfo(app: ElectronApplication): Promise<DesktopWindowInfo[]> {
  const windows = await app.evaluate(({ BrowserWindow, screen }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      // HWNDs cross the Playwright bridge as strings: BigInt is not serializable.
      hwnd: window.getNativeWindowHandle().readBigUInt64LE(0).toString(),
      url: window.webContents.getURL(),
      bounds: window.getBounds(),
      screenBounds: screen.dipToScreenRect(window, window.getBounds())
    }))
  )
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
  /** Makes `hwnd` the foreground window, then presses Alt+F4 for real. */
  altF4(hwnd: Hwnd): boolean
  /** Makes `hwnd` the foreground window, then presses Ctrl+<letter> for real. */
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
      const focused = win32.setForeground(hwnd)
      win32.pressAltF4()
      return focused
    },
    ctrl(hwnd, letter) {
      const focused = win32.setForeground(hwnd)
      win32.pressCtrl(letter.toUpperCase().charCodeAt(0))
      return focused
    },
    foregroundWindow: () => win32.foregroundWindow(),
    isSeated: (hwnd) => {
      const shell = api.getShellWindow()
      return shell !== null && api.isAbove(hwnd, shell)
    }
  }
}
