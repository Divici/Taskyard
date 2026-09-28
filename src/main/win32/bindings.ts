import type koffiModule from 'koffi'
import type { Hwnd } from './api'
import { DWMWA_CLOAKED, GWL_EXSTYLE, WS_EX_TOPMOST } from './constants'

export type Koffi = typeof koffiModule
type KoffiType = ReturnType<Koffi['type']>

export interface WindowRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** A koffi registered-callback handle (`koffi.register`), valid until `koffi.unregister`. */
export type CallbackHandle = bigint

/**
 * Typed koffi declarations of the Win32 functions Taskyard calls. HWNDs are `void *` (BigInt
 * in and out); `hWndInsertAfter` is `intptr_t` so the negative `HWND_*` sentinels pass as-is.
 * Callback types and WINDOWPOS are anonymous: koffi's named-type registry lives in the native
 * addon and outlives a re-imported JS module, so names would collide on a second load.
 */
export interface Win32Bindings {
  koffi: Koffi
  // user32
  SetWindowPos(
    hwnd: Hwnd,
    insertAfter: number,
    x: number,
    y: number,
    cx: number,
    cy: number,
    flags: number
  ): boolean
  ShowWindow(hwnd: Hwnd, command: number): boolean
  GetWindow(hwnd: Hwnd, command: number): Hwnd | null
  GetShellWindow(): Hwnd | null
  FindWindowExW(
    parent: Hwnd | null,
    after: Hwnd | null,
    className: string | null,
    title: string | null
  ): Hwnd | null
  EnumWindows(callback: (hwnd: Hwnd, lParam: number) => boolean, lParam: number): boolean
  SetWinEventHook(
    eventMin: number,
    eventMax: number,
    module: null,
    callback: CallbackHandle,
    processId: number,
    threadId: number,
    flags: number
  ): bigint | null
  UnhookWinEvent(hook: bigint): boolean
  /** Phase 12: `GetWindowThreadProcessId`'s process id (0 for a window that is gone). */
  processIdOf(hwnd: Hwnd): number
  SystemParametersInfoW(
    action: number,
    uiParam: number,
    pvParam: Buffer | null,
    winIni: number
  ): boolean
  GetWindowLongPtrW(hwnd: Hwnd, index: number): number | bigint
  IsWindowVisible(hwnd: Hwnd): boolean
  IsIconic(hwnd: Hwnd): boolean
  GetWindowRect(hwnd: Hwnd, rect: WindowRect): boolean
  /** Fills `point` (screen coordinates, physical pixels). */
  GetCursorPos(point: { x: number; y: number }): boolean
  /** POINT passed by value. */
  WindowFromPoint(point: { x: number; y: number }): Hwnd | null
  GetAncestor(hwnd: Hwnd, flags: number): Hwnd | null
  /** SHORT: the high bit (negative) means the key is down now. */
  GetAsyncKeyState(vk: number): number
  GetSystemMetrics(index: number): number
  // dwmapi
  DwmGetWindowAttribute(hwnd: Hwnd, attribute: number, value: [number], size: number): number
  // comctl32
  SetWindowSubclass(hwnd: Hwnd, callback: CallbackHandle, id: number, refData: number): boolean
  RemoveWindowSubclass(hwnd: Hwnd, callback: CallbackHandle, id: number): boolean
  DefSubclassProc(hwnd: Hwnd, message: number, wParam: number, lParam: number): number | bigint
  // advapi32
  RegGetValueW(
    hkey: number,
    subKey: string,
    value: string,
    flags: number,
    type: null,
    data: Buffer | null,
    dataBytes: [number]
  ): number
  // kernel32
  GetFileAttributesW(path: string): number
  SetFileAttributesW(path: string, attributes: number): boolean
  /** Returns the HANDLE as an `intptr_t` (`INVALID_HANDLE_VALUE` = -1). */
  CreateFileW(
    path: string,
    access: number,
    share: number,
    security: null,
    disposition: number,
    flags: number,
    template: null
  ): number | bigint
  CloseHandle(handle: number | bigint): boolean
  MoveFileExW(from: string, to: string, flags: number): boolean
  /** koffi keeps the last error of the previous koffi call, so this reads that call's error. */
  GetLastError(): number
  // types
  /** `LRESULT CALLBACK SUBCLASSPROC(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR)` pointer. */
  SubclassProc: KoffiType
  /** `void CALLBACK WINEVENTPROC(HWINEVENTHOOK, DWORD, HWND, LONG, LONG, DWORD, DWORD)` pointer. */
  WinEventProc: KoffiType
  WINDOWPOS: KoffiType
  // helpers built on the above
  isTopmost(hwnd: Hwnd): boolean
  /** Visible, not minimized, not DWM-cloaked and not empty: it would show if uncovered. */
  isOnScreen(hwnd: Hwnd): boolean
  /** Every top-level window, top of the z-order first (`EnumWindows`). */
  enumWindows(): Hwnd[]
}

const cache = new WeakMap<Koffi, Win32Bindings>()

/**
 * Win32 `BOOL` is a 32-bit int (C's 1-byte `bool` would read only the low byte), so every BOOL
 * is declared `int` and converted here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toBool<A extends any[]>(fn: (...args: A) => number): (...args: A) => boolean {
  return (...args) => fn(...args) !== 0
}

/** Loads user32/comctl32/advapi32/kernel32/dwmapi and declares the functions (once per koffi). */
export function loadWin32Bindings(koffi: Koffi): Win32Bindings {
  const cached = cache.get(koffi)
  if (cached) return cached

  const user32 = koffi.load('user32.dll')
  const comctl32 = koffi.load('comctl32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const dwmapi = koffi.load('dwmapi.dll')

  const subclassProto = koffi.proto('__stdcall', null, 'intptr_t', [
    'void *',
    'uint32_t',
    'uintptr_t',
    'intptr_t',
    'uintptr_t',
    'uintptr_t'
  ])
  const winEventProto = koffi.proto('__stdcall', null, 'void', [
    'void *',
    'uint32_t',
    'void *',
    'long',
    'long',
    'uint32_t',
    'uint32_t'
  ])
  // WNDENUMPROC returns BOOL.
  const enumProto = koffi.proto('__stdcall', null, 'int', ['void *', 'intptr_t'])
  const SubclassProc = koffi.pointer(subclassProto)
  const WinEventProc = koffi.pointer(winEventProto)

  const WINDOWPOS = koffi.struct({
    hwnd: 'void *',
    hwndInsertAfter: 'intptr_t',
    x: 'int',
    y: 'int',
    cx: 'int',
    cy: 'int',
    flags: 'uint32_t'
  })

  const RECT = koffi.struct({ left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const POINT = koffi.struct({ x: 'long', y: 'long' })
  const GetCursorPos = toBool(
    user32.func('__stdcall', 'GetCursorPos', 'int', [koffi.out(koffi.pointer(POINT))])
  )
  const WindowFromPoint = user32.func('__stdcall', 'WindowFromPoint', 'void *', [POINT])
  const GetWindowThreadProcessId = user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'
  )
  const IsWindowVisible = toBool(user32.func('int __stdcall IsWindowVisible(void *hwnd)'))
  const IsIconic = toBool(user32.func('int __stdcall IsIconic(void *hwnd)'))
  const GetWindowRect = toBool(
    user32.func('__stdcall', 'GetWindowRect', 'int', ['void *', koffi.out(koffi.pointer(RECT))])
  )
  const DwmGetWindowAttribute = dwmapi.func(
    'long __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t attribute, _Out_ uint32_t *value, uint32_t size)'
  )
  const isCloaked = (hwnd: Hwnd): boolean => {
    const cloaked: [number] = [0]
    return DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0] !== 0
  }
  const hasArea = (hwnd: Hwnd): boolean => {
    const rect: WindowRect = { left: 0, top: 0, right: 0, bottom: 0 }
    return GetWindowRect(hwnd, rect) && rect.right > rect.left && rect.bottom > rect.top
  }

  const GetWindowLongPtrW = user32.func(
    'intptr_t __stdcall GetWindowLongPtrW(void *hwnd, int index)'
  )
  const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int', [
    koffi.pointer(enumProto),
    'intptr_t'
  ])

  const bindings: Win32Bindings = {
    koffi,
    SetWindowPos: toBool(
      user32.func(
        'int __stdcall SetWindowPos(void *hwnd, intptr_t insertAfter, int x, int y, int cx, int cy, uint32_t flags)'
      )
    ),
    ShowWindow: toBool(user32.func('int __stdcall ShowWindow(void *hwnd, int command)')),
    GetWindow: user32.func('void * __stdcall GetWindow(void *hwnd, uint32_t command)'),
    GetShellWindow: user32.func('void * __stdcall GetShellWindow()'),
    FindWindowExW: user32.func(
      'void * __stdcall FindWindowExW(void *parent, void *after, str16 className, str16 title)'
    ),
    EnumWindows: (callback, lParam) =>
      EnumWindows((hwnd: Hwnd, param: number) => (callback(hwnd, param) ? 1 : 0), lParam) !== 0,
    SetWinEventHook: user32.func('__stdcall', 'SetWinEventHook', 'void *', [
      'uint32_t',
      'uint32_t',
      'void *',
      WinEventProc,
      'uint32_t',
      'uint32_t',
      'uint32_t'
    ]),
    UnhookWinEvent: toBool(user32.func('int __stdcall UnhookWinEvent(void *hook)')),
    processIdOf: (hwnd) => {
      const pid: [number] = [0]
      GetWindowThreadProcessId(hwnd, pid)
      return pid[0]
    },
    SystemParametersInfoW: toBool(
      user32.func(
        'int __stdcall SystemParametersInfoW(uint32_t action, uint32_t uiParam, void *pvParam, uint32_t winIni)'
      )
    ),
    GetWindowLongPtrW,
    IsWindowVisible,
    IsIconic,
    GetWindowRect,
    GetCursorPos,
    WindowFromPoint,
    GetAncestor: user32.func('void * __stdcall GetAncestor(void *hwnd, uint32_t flags)'),
    GetAsyncKeyState: user32.func('int16_t __stdcall GetAsyncKeyState(int vk)'),
    GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int index)'),
    DwmGetWindowAttribute,
    SetWindowSubclass: toBool(
      comctl32.func('__stdcall', 'SetWindowSubclass', 'int', [
        'void *',
        SubclassProc,
        'uintptr_t',
        'uintptr_t'
      ])
    ),
    RemoveWindowSubclass: toBool(
      comctl32.func('__stdcall', 'RemoveWindowSubclass', 'int', [
        'void *',
        SubclassProc,
        'uintptr_t'
      ])
    ),
    DefSubclassProc: comctl32.func(
      'intptr_t __stdcall DefSubclassProc(void *hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)'
    ),
    RegGetValueW: advapi32.func(
      'long __stdcall RegGetValueW(intptr_t hkey, str16 subKey, str16 value, uint32_t flags, void *type, void *data, _Inout_ uint32_t *dataBytes)'
    ),
    GetFileAttributesW: kernel32.func('uint32_t __stdcall GetFileAttributesW(str16 path)'),
    SetFileAttributesW: toBool(
      kernel32.func('int __stdcall SetFileAttributesW(str16 path, uint32_t attributes)')
    ),
    CreateFileW: kernel32.func(
      'intptr_t __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *template)'
    ),
    CloseHandle: toBool(kernel32.func('int __stdcall CloseHandle(intptr_t handle)')),
    MoveFileExW: toBool(
      kernel32.func('int __stdcall MoveFileExW(str16 from, str16 to, uint32_t flags)')
    ),
    GetLastError: kernel32.func('uint32_t __stdcall GetLastError()'),
    SubclassProc,
    WinEventProc,
    WINDOWPOS,
    isTopmost: (hwnd) => (Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOPMOST) !== 0,
    isOnScreen: (hwnd) =>
      IsWindowVisible(hwnd) && !IsIconic(hwnd) && !isCloaked(hwnd) && hasArea(hwnd),
    enumWindows: () => {
      const windows: Hwnd[] = []
      bindings.EnumWindows((hwnd) => {
        windows.push(hwnd)
        return true
      }, 0)
      return windows
    }
  }
  cache.set(koffi, bindings)
  return bindings
}
