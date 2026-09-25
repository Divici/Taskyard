import type { Hwnd } from '../../src/main/win32/api'
import { loadWin32Bindings, type Koffi, type WindowRect } from '../../src/main/win32/bindings'
import { GWL_EXSTYLE } from '../../src/main/win32/constants'
import { parseEnvironmentBlock } from './env-block'
import { sleepSync } from './sleep-sync'

/**
 * Win32 calls that only the acceptance tooling needs (`verify:zorder`, e2e helpers): they
 * inspect and drive other processes' windows. Calls the app also uses come from the app's own
 * bindings (`src/main/win32/bindings.ts`); only the extra ones are declared here.
 */

export type Rect = WindowRect

export interface ScriptWin32 {
  /** Per-monitor DPI awareness, so rects and cursor positions are physical pixels. */
  makeDpiAware(): void
  monitorCount(): number
  /** Size of the primary monitor (whose top-left is always 0,0). */
  primaryScreen(): { width: number; height: number }
  /** The Terminal Services session this process runs in. */
  sessionId(): number
  /** Top-level windows of `className`, top of the z-order first. */
  findWindows(className: string): Hwnd[]
  processIdOf(hwnd: Hwnd): number
  titleOf(hwnd: Hwnd): string
  classOf(hwnd: Hwnd): string
  isVisible(hwnd: Hwnd): boolean
  isIconic(hwnd: Hwnd): boolean
  exStyleOf(hwnd: Hwnd): number
  rectOf(hwnd: Hwnd): Rect
  foregroundWindow(): Hwnd | null
  /**
   * `SetForegroundWindow` from a background process: first with Alt held (synthesized input
   * lifts the foreground lock), then attached to the foreground thread's input.
   */
  setForeground(hwnd: Hwnd): boolean
  /** The top-level window under a screen point (`WindowFromPoint` → `GetAncestor(GA_ROOT)`). */
  topLevelWindowAt(x: number, y: number): Hwnd | null
  /** A point on `hwnd` that no other window covers (a 19×11 grid is tried), or null. */
  uncoveredPoint(hwnd: Hwnd): { x: number; y: number } | null
  /** The composed screen colour at a point, as 0xRRGGBB. */
  screenPixel(x: number, y: number): number
  /** A left click at a screen point (the cursor stays there). */
  clickAt(x: number, y: number): void
  /** The real Win+D keystroke (Win down, D down, D up, Win up). */
  pressWinD(): void
  /** The real Alt+F4 keystroke, delivered to the foreground window. */
  pressAltF4(): void
  /** A real Ctrl+<key> keystroke (`key` is a virtual-key code, e.g. 0x57 for W). */
  pressCtrl(key: number): void
  /** Presses the virtual keys down in order and releases them in reverse (a shortcut chord). */
  pressChord(keys: readonly number[]): void
  postClose(hwnd: Hwnd): void
  cursor(): { x: number; y: number }
  moveCursor(x: number, y: number): void
  appbarState(): number
  setAppbarState(state: number): void
  /** The user's default environment (registry-derived, like at logon), or null on failure. */
  userEnvironment(): Record<string, string> | null
}

const VK_MENU = 0x12
const VK_LWIN = 0x5b
const VK_D = 0x44
const VK_F4 = 0x73
const VK_CONTROL = 0x11
const KEYEVENTF_KEYUP = 0x2
const MOUSEEVENTF_LEFTDOWN = 0x2
const MOUSEEVENTF_LEFTUP = 0x4
const GA_ROOT = 2
const INPUT_SETTLE_MS = 50
const WM_CLOSE = 0x0010
const SM_CXSCREEN = 0
const SM_CYSCREEN = 1
const SM_CMONITORS = 80
const ABM_GETSTATE = 0x4
const ABM_SETSTATE = 0xa
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
const TOKEN_QUERY = 0x0008
const TOKEN_DUPLICATE = 0x0002
const MAX_ENV_ENTRIES = 4096
const GRID_COLUMNS = 20
const GRID_ROWS = 12

const cache = new WeakMap<Koffi, ScriptWin32>()

export function loadScriptWin32(koffi: Koffi): ScriptWin32 {
  const cached = cache.get(koffi)
  if (cached) return cached

  const b = loadWin32Bindings(koffi)
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const shell32 = koffi.load('shell32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const userenv = koffi.load('userenv.dll')

  // Win32 BOOL is a 32-bit int: every BOOL below is declared `int` and compared with 0.
  const RECT = koffi.struct({ left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const POINT = koffi.struct({ x: 'long', y: 'long' })
  const APPBARDATA = koffi.struct({
    cbSize: 'uint32_t',
    hWnd: 'void *',
    uCallbackMessage: 'uint32_t',
    uEdge: 'uint32_t',
    rc: RECT,
    lParam: 'intptr_t'
  })

  const GetWindowThreadProcessId = user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'
  )
  const GetWindowTextW = user32.func(
    'int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *text, int max)'
  )
  const GetClassNameW = user32.func(
    'int __stdcall GetClassNameW(void *hwnd, _Out_ uint16_t *name, int max)'
  )
  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()')
  const SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(void *hwnd)')
  const AttachThreadInput = user32.func(
    'int __stdcall AttachThreadInput(uint32_t from, uint32_t to, int attach)'
  )
  const GetCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()')
  const GetCurrentProcessId = kernel32.func('uint32_t __stdcall GetCurrentProcessId()')
  const ProcessIdToSessionId = kernel32.func(
    'int __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t *session)'
  )
  const keybdEvent = user32.func(
    'void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)'
  )
  const mouseEvent = user32.func(
    'void __stdcall mouse_event(uint32_t flags, uint32_t dx, uint32_t dy, uint32_t data, uintptr_t extra)'
  )
  const PostMessageW = user32.func(
    'int __stdcall PostMessageW(void *hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)'
  )
  const GetCursorPos = user32.func('__stdcall', 'GetCursorPos', 'int', [
    koffi.out(koffi.pointer(POINT))
  ])
  const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)')
  const WindowFromPoint = user32.func('__stdcall', 'WindowFromPoint', 'void *', [POINT])
  const GetAncestor = user32.func('void * __stdcall GetAncestor(void *hwnd, uint32_t flags)')
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)')
  const SetProcessDpiAwarenessContext = user32.func(
    'int __stdcall SetProcessDpiAwarenessContext(intptr_t context)'
  )
  const GetDC = user32.func('void * __stdcall GetDC(void *hwnd)')
  const ReleaseDC = user32.func('int __stdcall ReleaseDC(void *hwnd, void *dc)')
  const GetPixel = gdi32.func('uint32_t __stdcall GetPixel(void *dc, int x, int y)')
  const SHAppBarMessage = shell32.func('__stdcall', 'SHAppBarMessage', 'uintptr_t', [
    'uint32_t',
    koffi.inout(koffi.pointer(APPBARDATA))
  ])
  const GetCurrentProcess = kernel32.func('void * __stdcall GetCurrentProcess()')
  const CloseHandle = kernel32.func('int __stdcall CloseHandle(void *handle)')
  const OpenProcessToken = advapi32.func(
    'int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)'
  )
  const CreateEnvironmentBlock = userenv.func(
    'int __stdcall CreateEnvironmentBlock(_Out_ void **environment, void *token, int inherit)'
  )
  const DestroyEnvironmentBlock = userenv.func(
    'int __stdcall DestroyEnvironmentBlock(void *environment)'
  )

  const text = (read: (buffer: Uint16Array, max: number) => number): string => {
    const buffer = new Uint16Array(512)
    return String.fromCharCode(...buffer.subarray(0, read(buffer, buffer.length)))
  }
  const appbar = (lParam = 0): Record<string, unknown> => ({
    cbSize: koffi.sizeof(APPBARDATA),
    hWnd: b.FindWindowExW(null, null, 'Shell_TrayWnd', null),
    uCallbackMessage: 0,
    uEdge: 0,
    rc: { left: 0, top: 0, right: 0, bottom: 0 },
    lParam
  })
  const rectOf = (hwnd: Hwnd): Rect => {
    const rect = { left: 0, top: 0, right: 0, bottom: 0 }
    b.GetWindowRect(hwnd, rect)
    return rect
  }
  const topLevelWindowAt = (x: number, y: number): Hwnd | null => {
    const hwnd = WindowFromPoint({ x, y }) as Hwnd | null
    return hwnd === null ? null : (GetAncestor(hwnd, GA_ROOT) as Hwnd | null)
  }

  const win32: ScriptWin32 = {
    makeDpiAware: () =>
      void SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2),
    monitorCount: () => GetSystemMetrics(SM_CMONITORS),
    primaryScreen: () => ({
      width: GetSystemMetrics(SM_CXSCREEN),
      height: GetSystemMetrics(SM_CYSCREEN)
    }),
    sessionId() {
      const session: [number] = [0]
      if (ProcessIdToSessionId(GetCurrentProcessId(), session) === 0) {
        throw new Error('ProcessIdToSessionId failed')
      }
      return session[0]
    },
    findWindows(className) {
      const windows: Hwnd[] = []
      for (let hwnd = b.FindWindowExW(null, null, className, null); hwnd !== null;) {
        windows.push(hwnd)
        hwnd = b.FindWindowExW(null, hwnd, className, null)
      }
      return windows
    },
    processIdOf(hwnd) {
      const pid: [number] = [0]
      GetWindowThreadProcessId(hwnd, pid)
      return pid[0]
    },
    titleOf: (hwnd) => text((buffer, max) => GetWindowTextW(hwnd, buffer, max)),
    classOf: (hwnd) => text((buffer, max) => GetClassNameW(hwnd, buffer, max)),
    isVisible: (hwnd) => b.IsWindowVisible(hwnd),
    isIconic: (hwnd) => b.IsIconic(hwnd),
    exStyleOf: (hwnd) => Number(b.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)),
    rectOf,
    foregroundWindow: () => GetForegroundWindow(),
    setForeground(hwnd) {
      keybdEvent(VK_MENU, 0, 0, 0)
      try {
        // Injected input is processed asynchronously; let the Alt press land first.
        sleepSync(INPUT_SETTLE_MS)
        SetForegroundWindow(hwnd)
      } finally {
        keybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
      }
      if (GetForegroundWindow() === hwnd) return true
      const foreground = GetForegroundWindow()
      if (foreground === null) return false
      const self = GetCurrentThreadId()
      const target = GetWindowThreadProcessId(foreground, [0])
      AttachThreadInput(self, target, 1)
      try {
        SetForegroundWindow(hwnd)
      } finally {
        AttachThreadInput(self, target, 0)
      }
      return GetForegroundWindow() === hwnd
    },
    topLevelWindowAt,
    uncoveredPoint(hwnd) {
      const r = rectOf(hwnd)
      for (let row = 1; row < GRID_ROWS; row++) {
        for (let column = 1; column < GRID_COLUMNS; column++) {
          const x = Math.round(r.left + ((r.right - r.left) * column) / GRID_COLUMNS)
          const y = Math.round(r.top + ((r.bottom - r.top) * row) / GRID_ROWS)
          if (topLevelWindowAt(x, y) === hwnd) return { x, y }
        }
      }
      return null
    },
    screenPixel(x, y) {
      const dc = GetDC(null)
      try {
        const bgr = GetPixel(dc, x, y) as number
        return ((bgr & 0xff) << 16) | (bgr & 0xff00) | ((bgr >> 16) & 0xff)
      } finally {
        ReleaseDC(null, dc)
      }
    },
    clickAt(x, y) {
      SetCursorPos(x, y)
      mouseEvent(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
      mouseEvent(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    },
    pressWinD() {
      keybdEvent(VK_LWIN, 0, 0, 0)
      keybdEvent(VK_D, 0, 0, 0)
      keybdEvent(VK_D, 0, KEYEVENTF_KEYUP, 0)
      keybdEvent(VK_LWIN, 0, KEYEVENTF_KEYUP, 0)
    },
    pressAltF4() {
      keybdEvent(VK_MENU, 0, 0, 0)
      keybdEvent(VK_F4, 0, 0, 0)
      keybdEvent(VK_F4, 0, KEYEVENTF_KEYUP, 0)
      keybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
    },
    pressCtrl(key) {
      keybdEvent(VK_CONTROL, 0, 0, 0)
      keybdEvent(key, 0, 0, 0)
      keybdEvent(key, 0, KEYEVENTF_KEYUP, 0)
      keybdEvent(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0)
    },
    pressChord(keys) {
      for (const key of keys) keybdEvent(key, 0, 0, 0)
      for (const key of [...keys].reverse()) keybdEvent(key, 0, KEYEVENTF_KEYUP, 0)
    },
    postClose: (hwnd) => void PostMessageW(hwnd, WM_CLOSE, 0, 0),
    cursor() {
      const point = { x: 0, y: 0 }
      GetCursorPos(point)
      return point
    },
    moveCursor: (x, y) => void SetCursorPos(x, y),
    appbarState: () => Number(SHAppBarMessage(ABM_GETSTATE, appbar())),
    setAppbarState: (state) => void SHAppBarMessage(ABM_SETSTATE, appbar(state)),
    userEnvironment() {
      const token: [bigint | null] = [null]
      if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, token) === 0) {
        return null
      }
      const block: [bigint | null] = [null]
      try {
        if (CreateEnvironmentBlock(block, token[0], 0) === 0 || block[0] === null) return null
        const entries: string[] = []
        let offset = 0n
        for (let index = 0; index < MAX_ENV_ENTRIES; index++) {
          const entry = koffi.decode.string16(block[0] + offset)
          if (!entry) break
          entries.push(entry)
          offset += BigInt((entry.length + 1) * 2)
        }
        return parseEnvironmentBlock(`${entries.join('\0')}\0\0`)
      } finally {
        if (block[0] !== null) DestroyEnvironmentBlock(block[0])
        CloseHandle(token[0])
      }
    }
  }
  cache.set(koffi, win32)
  return win32
}
