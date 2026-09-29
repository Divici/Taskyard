import type { Koffi } from '../../src/main/win32/bindings'
import { namedType } from '../../src/main/win32/shell-menu-native'

/**
 * Win32 calls the shell-menu spike uses to watch and drive another process's popup menu: find
 * its visible menu windows (class `#32768`), read their items across processes (menus live in
 * the desktop heap, so `MN_GETHMENU` + `GetMenuItemInfoW` work from outside), and send it real
 * input. Scripts only; the app never drives menus this way.
 */

export interface MenuWindowInfo {
  hwnd: string
  rect: { left: number; top: number; right: number; bottom: number }
  labels: string[]
  /** The highlighted item's label (MFS_HILITE), or null. */
  highlighted: string | null
  /** Labels of the checked items (MFS_CHECKED). */
  checked: string[]
  /** Labels of the items drawn with a radio bullet (MFT_RADIOCHECK). */
  radio: string[]
}

export interface TopLevelWindowInfo {
  hwnd: bigint
  className: string
  title: string
  visible: boolean
}

export interface MenuInspector {
  /** Visible popup menu windows of process `pid`, top of the z-order first. */
  menuWindows(pid: number): MenuWindowInfo[]
  /** Every top-level window of process `pid`. */
  windowsOf(pid: number): TopLevelWindowInfo[]
  foregroundWindow(): bigint | null
  /** A real right click (SendInput) at a screen point; the cursor stays there. */
  rightClickAt(x: number, y: number): void
  /** A real key press and release (SendInput) — it goes to the foreground thread. */
  pressKey(vk: number): void
  postMessage(hwnd: bigint, message: number): boolean
  cursor(): { x: number; y: number }
  moveCursor(x: number, y: number): void
}

export const VK_RETURN = 0x0d
export const VK_ESCAPE = 0x1b
export const VK_RIGHT = 0x27
export const VK_DOWN = 0x28
export const WM_CLOSE = 0x0010
export const WM_CANCELMODE = 0x001f

const MN_GETHMENU = 0x01e1
const MIIM_STATE = 0x1
const MIIM_FTYPE = 0x100
const MFT_SEPARATOR = 0x800
const MFS_HILITE = 0x80
const MFS_CHECKED = 0x8
const MFT_RADIOCHECK = 0x200
const MF_BYPOSITION = 0x400
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const MOUSEEVENTF_RIGHTDOWN = 0x8
const MOUSEEVENTF_RIGHTUP = 0x10
const KEYEVENTF_KEYUP = 0x2

export function loadMenuInspector(koffi: Koffi): MenuInspector {
  const user32 = koffi.load('user32.dll')
  // Named types: see namedType in shell-menu-koffi.ts for why anonymous struct pointers break.
  const struct = (name: string, def: Record<string, unknown>): ReturnType<Koffi['type']> =>
    namedType(koffi, `Spike_${name}`, (full) => koffi.struct(full, def as never))
  const RECT = struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const POINT = struct('POINT', { x: 'long', y: 'long' })
  const MOUSEINPUT = struct('MOUSEINPUT', {
    dx: 'long',
    dy: 'long',
    mouseData: 'uint32_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t'
  })
  const KEYBDINPUT = struct('KEYBDINPUT', {
    wVk: 'uint16_t',
    wScan: 'uint16_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t'
  })
  const INPUT = struct('INPUT', {
    type: 'uint32_t',
    u: namedType(koffi, 'Spike_INPUT_UNION', (full) =>
      koffi.union(full, { mi: MOUSEINPUT, ki: KEYBDINPUT })
    )
  })
  const MENUITEMINFOW = struct('MENUITEMINFOW', {
    cbSize: 'uint32_t',
    fMask: 'uint32_t',
    fType: 'uint32_t',
    fState: 'uint32_t',
    wID: 'uint32_t',
    hSubMenu: 'void *',
    hbmpChecked: 'void *',
    hbmpUnchecked: 'void *',
    dwItemData: 'uintptr_t',
    dwTypeData: 'void *',
    cch: 'uint32_t',
    hbmpItem: 'void *'
  })

  const FindWindowExW = user32.func(
    'void * __stdcall FindWindowExW(void *parent, void *after, str16 className, str16 title)'
  )
  const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int', [
    koffi.pointer(
      namedType(koffi, 'Spike_WNDENUMPROC', (full) =>
        koffi.proto('__stdcall', full, 'int', ['void *', 'intptr_t'])
      )
    ),
    'intptr_t'
  ])
  const GetWindowThreadProcessId = user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'
  )
  const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(void *hwnd)')
  const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int', [
    'void *',
    koffi.out(koffi.pointer(RECT))
  ])
  const GetClassNameW = user32.func(
    'int __stdcall GetClassNameW(void *hwnd, _Out_ uint16_t *name, int max)'
  )
  const GetWindowTextW = user32.func(
    'int __stdcall GetWindowTextW(void *hwnd, _Out_ uint16_t *text, int max)'
  )
  const SendMessageW = user32.func(
    'intptr_t __stdcall SendMessageW(void *hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)'
  )
  const PostMessageW = user32.func(
    'int __stdcall PostMessageW(void *hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)'
  )
  const GetMenuItemCount = user32.func('int __stdcall GetMenuItemCount(void *menu)')
  const GetMenuStringW = user32.func(
    'int __stdcall GetMenuStringW(void *menu, uint32_t item, _Out_ uint16_t *text, int max, uint32_t flags)'
  )
  const GetMenuItemInfoW = user32.func('__stdcall', 'GetMenuItemInfoW', 'int', [
    'void *',
    'uint32_t',
    'int',
    koffi.inout(koffi.pointer(MENUITEMINFOW))
  ])
  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()')
  const SendInput = user32.func('__stdcall', 'SendInput', 'uint32_t', [
    'uint32_t',
    koffi.pointer(INPUT),
    'int'
  ])
  const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)')
  const GetCursorPos = user32.func('__stdcall', 'GetCursorPos', 'int', [
    koffi.out(koffi.pointer(POINT))
  ])

  const text = (read: (buffer: Uint16Array, max: number) => number): string => {
    const buffer = new Uint16Array(512)
    return String.fromCharCode(...buffer.subarray(0, read(buffer, buffer.length)))
  }
  const pidOf = (hwnd: bigint): number => {
    const pid: [number] = [0]
    GetWindowThreadProcessId(hwnd, pid)
    return pid[0]
  }
  const send = (inputs: unknown[]): void => {
    SendInput(inputs.length, inputs, koffi.sizeof(INPUT))
  }
  const key = (vk: number, up: boolean): unknown => ({
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: vk, wScan: 0, dwFlags: up ? KEYEVENTF_KEYUP : 0, time: 0, dwExtraInfo: 0 } }
  })
  const mouse = (flags: number): unknown => ({
    type: INPUT_MOUSE,
    u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } }
  })

  const readMenu = (
    menu: bigint
  ): Pick<MenuWindowInfo, 'labels' | 'highlighted' | 'checked' | 'radio'> => {
    const labels: string[] = []
    const checked: string[] = []
    const radio: string[] = []
    let highlighted: string | null = null
    const count = GetMenuItemCount(menu) as number
    for (let position = 0; position < count; position++) {
      const info = {
        cbSize: koffi.sizeof(MENUITEMINFOW),
        fMask: MIIM_FTYPE | MIIM_STATE,
        fType: 0,
        fState: 0,
        wID: 0,
        hSubMenu: null,
        hbmpChecked: null,
        hbmpUnchecked: null,
        dwItemData: 0,
        dwTypeData: null,
        cch: 0,
        hbmpItem: null
      }
      GetMenuItemInfoW(menu, position, 1, info)
      const label =
        (info.fType & MFT_SEPARATOR) !== 0
          ? '---'
          : text((buffer, max) => GetMenuStringW(menu, position, buffer, max, MF_BYPOSITION))
      labels.push(label)
      if ((info.fState & MFS_HILITE) !== 0) highlighted = label
      if ((info.fState & MFS_CHECKED) !== 0) checked.push(label)
      if ((info.fType & MFT_RADIOCHECK) !== 0) radio.push(label)
    }
    return { labels, highlighted, checked, radio }
  }

  return {
    menuWindows(pid) {
      const found: MenuWindowInfo[] = []
      for (
        let hwnd = FindWindowExW(null, null, '#32768', null) as bigint | null;
        hwnd !== null;
        hwnd = FindWindowExW(null, hwnd, '#32768', null) as bigint | null
      ) {
        if (pidOf(hwnd) !== pid || !IsWindowVisible(hwnd)) continue
        const menu = SendMessageW(hwnd, MN_GETHMENU, 0, 0) as bigint | number
        const rect = { left: 0, top: 0, right: 0, bottom: 0 }
        GetWindowRect(hwnd, rect)
        const read = menu
          ? readMenu(BigInt(menu))
          : { labels: [], highlighted: null, checked: [], radio: [] }
        found.push({ hwnd: String(hwnd), rect, ...read })
      }
      return found
    },
    windowsOf(pid) {
      const windows: TopLevelWindowInfo[] = []
      EnumWindows((hwnd: bigint) => {
        if (pidOf(hwnd) === pid) {
          windows.push({
            hwnd,
            className: text((buffer, max) => GetClassNameW(hwnd, buffer, max)),
            title: text((buffer, max) => GetWindowTextW(hwnd, buffer, max)),
            visible: IsWindowVisible(hwnd) !== 0
          })
        }
        return 1
      }, 0)
      return windows
    },
    foregroundWindow: () => GetForegroundWindow() as bigint | null,
    rightClickAt(x, y) {
      SetCursorPos(x, y)
      send([mouse(MOUSEEVENTF_RIGHTDOWN), mouse(MOUSEEVENTF_RIGHTUP)])
    },
    pressKey(vk) {
      send([key(vk, false), key(vk, true)])
    },
    postMessage: (hwnd, message) => PostMessageW(hwnd, message, 0, 0) !== 0,
    cursor() {
      const point = { x: 0, y: 0 }
      GetCursorPos(point)
      return point
    },
    moveCursor: (x, y) => void SetCursorPos(x, y)
  }
}
