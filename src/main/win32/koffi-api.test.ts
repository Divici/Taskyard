import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Hwnd, Win32Api } from './api'
import type { CallbackHandle, Koffi, Win32Bindings } from './bindings'
import {
  ERROR_ACCESS_DENIED,
  GA_ROOT,
  SM_SWAPBUTTON,
  VK_LBUTTON,
  VK_RBUTTON,
  FILE_ADD_FILE,
  FILE_DELETE_CHILD,
  FILE_FLAG_BACKUP_SEMANTICS,
  FILE_SHARE_DELETE,
  FILE_SHARE_READ,
  FILE_SHARE_WRITE,
  INVALID_HANDLE_VALUE,
  OPEN_EXISTING,
  ERROR_FILE_NOT_FOUND,
  ERROR_MORE_DATA,
  ERROR_SUCCESS,
  HWND_NOTOPMOST,
  HWND_TOPMOST,
  SWP_NOZORDER,
  SC_CLOSE,
  SC_MINIMIZE,
  WM_CANCELMODE,
  WM_NCDESTROY,
  WM_SYSCOMMAND,
  WM_WINDOWPOSCHANGING
} from './constants'
import { createKoffiWin32Api, GUARD_SUBCLASS_ID } from './koffi-api'

/**
 * Headless: koffi and the Win32 bindings are fakes, so this suite never loads a DLL. The same
 * code runs against real Windows in koffi-api.win32.test.ts (npm run test:win32).
 */

const SELF = 0x100n
const APP = 0x200n
const SHELL = 0x300n
const DEFVIEW = 0x301n
const DEF_RESULT = 77

type Proc = (hwnd: Hwnd, message: number, wParam: number, lParam: number) => number | bigint
type WindowPosFields = { hwndInsertAfter: number; flags: number }

interface FakeKoffi {
  koffi: {
    register: Mock<(fn: (...args: never[]) => unknown) => CallbackHandle>
    unregister: Mock<(handle: CallbackHandle) => void>
    offsetof: (type: unknown, field: string) => number
    decode: (pointer: bigint) => WindowPosFields
    encode: Mock<(pointer: bigint, offset: number, type: string, value: number) => void>
  }
  callbacks: Map<CallbackHandle, (...args: never[]) => unknown>
  memory: Map<bigint, WindowPosFields>
}

interface FakeBindings {
  b: {
    SetWindowPos: Mock<(...args: [Hwnd, number, number, number, number, number, number]) => boolean>
    SetWindowSubclass: Mock<(hwnd: Hwnd, handle: CallbackHandle) => boolean>
    RemoveWindowSubclass: Mock<(hwnd: Hwnd) => boolean>
    DefSubclassProc: Mock<() => number>
    RegGetValueW: Mock<(...args: unknown[]) => number>
    GetFileAttributesW: Mock<(path: string) => number>
    SetFileAttributesW: Mock<(path: string, attributes: number) => boolean>
    CreateFileW: Mock<(...args: unknown[]) => number | bigint>
    CloseHandle: Mock<(handle: number | bigint) => boolean>
    MoveFileExW: Mock<(...args: unknown[]) => boolean>
    GetLastError: Mock<() => number>
    [name: string]: unknown
  }
  order: Hwnd[]
  topmost: Set<Hwnd>
  subclasses: Map<Hwnd, CallbackHandle>
  failSetWindowPos(fail: boolean): void
}

/** A fake koffi: registered callbacks, and WINDOWPOS memory keyed by pointer. */
function fakeKoffi(): FakeKoffi {
  const callbacks = new Map<CallbackHandle, (...args: never[]) => unknown>()
  const memory = new Map<bigint, WindowPosFields>()
  let next = 1n
  const koffi = {
    register: vi.fn((fn: (...args: never[]) => unknown) => {
      const handle = next++
      callbacks.set(handle, fn)
      return handle
    }),
    unregister: vi.fn((handle: CallbackHandle) => {
      callbacks.delete(handle)
    }),
    offsetof: (_type: unknown, field: string) => (field === 'hwndInsertAfter' ? 8 : 32),
    decode: (pointer: bigint) => ({ ...memory.get(pointer)! }),
    encode: vi.fn((pointer: bigint, offset: number, _type: string, value: number) => {
      const pos = memory.get(pointer)!
      if (offset === 8) pos.hwndInsertAfter = value
      else pos.flags = value
    })
  }
  return { koffi, callbacks, memory }
}

/** Fake bindings over a z-order list (top first); SetWindowPos runs the subclass proc like Windows. */
function fakeBindings(fk: FakeKoffi): FakeBindings {
  const order: Hwnd[] = [SELF, APP, SHELL]
  const topmost = new Set<Hwnd>()
  const subclasses = new Map<Hwnd, CallbackHandle>()
  let setWindowPosResult = true
  let pointer = 0x9000n
  const b = {
    GetWindow: (hwnd: Hwnd, command: number): Hwnd | null => {
      const index = order.indexOf(hwnd)
      const other = command === 2 ? order[index + 1] : order[index - 1]
      return index < 0 || other === undefined ? null : other
    },
    GetShellWindow: () => SHELL,
    FindWindowExW: (parent: Hwnd | null, _after: Hwnd | null, className: string) =>
      parent === SHELL && className === 'SHELLDLL_DefView' ? DEFVIEW : null,
    isTopmost: (hwnd: Hwnd) => topmost.has(hwnd),
    isOnScreen: () => true,
    SetWindowPos: vi.fn(
      (
        hwnd: Hwnd,
        insertAfter: number,
        _x: number,
        _y: number,
        _cx: number,
        _cy: number,
        flags: number
      ) => {
        const handle = subclasses.get(hwnd)
        if (handle !== undefined) {
          const ptr = pointer++
          fk.memory.set(ptr, { hwndInsertAfter: insertAfter, flags })
          ;(fk.callbacks.get(handle) as unknown as Proc)(hwnd, WM_WINDOWPOSCHANGING, 0, Number(ptr))
        }
        return setWindowPosResult
      }
    ),
    ShowWindow: vi.fn(() => true),
    SetWindowSubclass: vi.fn((hwnd: Hwnd, handle: CallbackHandle) => {
      subclasses.set(hwnd, handle)
      return true
    }),
    RemoveWindowSubclass: vi.fn((hwnd: Hwnd) => subclasses.delete(hwnd)),
    DefSubclassProc: vi.fn(() => DEF_RESULT),
    SetWinEventHook: vi.fn(() => 0x55n),
    UnhookWinEvent: vi.fn(() => true),
    RegGetValueW: vi.fn<(...args: unknown[]) => number>(),
    GetFileAttributesW: vi.fn(() => 0x20),
    SetFileAttributesW: vi.fn(() => true),
    CreateFileW: vi.fn<(...args: unknown[]) => number | bigint>(() => 0x2a4),
    CloseHandle: vi.fn(() => true),
    MoveFileExW: vi.fn<(...args: unknown[]) => boolean>(() => true),
    GetLastError: vi.fn(() => 0),
    SubclassProc: {},
    WinEventProc: {},
    WINDOWPOS: {}
  }
  return {
    b,
    order,
    topmost,
    subclasses,
    failSetWindowPos: (fail: boolean) => {
      setWindowPosResult = !fail
    }
  }
}

let fk: FakeKoffi
let fb: FakeBindings
const log = { warn: vi.fn(), error: vi.fn() }

function createApi(): Win32Api {
  return createKoffiWin32Api(fk.koffi as unknown as Koffi, {
    log,
    bindings: fb.b as unknown as Win32Bindings
  })
}

/** Windows calling the guard with a WINDOWPOS; returns the rewritten fields and the result. */
function sendWindowPosChanging(
  hwnd: Hwnd,
  insertAfter: number,
  flags = 0
): { result: number | bigint; pos: WindowPosFields } {
  const handle = fb.subclasses.get(hwnd)!
  const ptr = 0x7000n
  fk.memory.set(ptr, { hwndInsertAfter: insertAfter, flags })
  const result = (fk.callbacks.get(handle) as unknown as Proc)(
    hwnd,
    WM_WINDOWPOSCHANGING,
    0,
    Number(ptr)
  )
  return { result, pos: fk.memory.get(ptr)! }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  fk = fakeKoffi()
  fb = fakeBindings(fk)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('z-order guard', () => {
  it('rewrites a raise to "just above the shell window" and passes on to DefSubclassProc', () => {
    const api = createApi()
    expect(api.installZOrderGuard(SELF, () => 'bottom')).toBe(true)

    const { result, pos } = sendWindowPosChanging(SELF, 0)

    expect(pos.hwndInsertAfter).toBe(Number(APP))
    expect(result).toBe(DEF_RESULT)
  })

  it('never touches a move that carries SWP_NOZORDER', () => {
    const api = createApi()
    api.installZOrderGuard(SELF, () => 'bottom')

    const { pos } = sendWindowPosChanging(SELF, 0, SWP_NOZORDER)

    expect(pos).toEqual({ hwndInsertAfter: 0, flags: SWP_NOZORDER })
  })

  it('still returns DefSubclassProc when mode() throws, and warns only once', () => {
    const api = createApi()
    api.installZOrderGuard(SELF, () => {
      throw new Error('mode exploded')
    })

    const first = sendWindowPosChanging(SELF, 0)
    const second = sendWindowPosChanging(SELF, 0)

    expect(first.result).toBe(DEF_RESULT)
    expect(second.result).toBe(DEF_RESULT)
    expect(fb.b.DefSubclassProc).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      'win32: z-order guard failed',
      expect.objectContaining({ message: 'mode exploded' })
    )
  })

  it('swallows Alt+F4 (WM_SYSCOMMAND SC_CLOSE) and passes every other system command on', () => {
    const api = createApi()
    api.installZOrderGuard(SELF, () => 'bottom')
    const proc = fk.callbacks.get(fb.subclasses.get(SELF)!) as unknown as Proc

    expect(proc(SELF, WM_SYSCOMMAND, SC_CLOSE, 0)).toBe(0)
    // Keyboard-initiated commands carry extra bits in the low nibble.
    expect(proc(SELF, WM_SYSCOMMAND, SC_CLOSE | 0x3, 0)).toBe(0)
    expect(fb.b.DefSubclassProc).not.toHaveBeenCalled()

    expect(proc(SELF, WM_SYSCOMMAND, SC_MINIMIZE, 0)).toBe(DEF_RESULT)
    expect(fb.b.DefSubclassProc).toHaveBeenCalledOnce()
  })

  it('removes itself on WM_NCDESTROY and releases the callback on a later turn', () => {
    const api = createApi()
    api.installZOrderGuard(SELF, () => 'bottom')
    const handle = fb.subclasses.get(SELF)!

    const result = (fk.callbacks.get(handle) as unknown as Proc)(SELF, WM_NCDESTROY, 0, 0)

    expect(result).toBe(DEF_RESULT)
    expect(fb.b.RemoveWindowSubclass).toHaveBeenCalledExactlyOnceWith(
      SELF,
      handle,
      GUARD_SUBCLASS_ID
    )
    expect(fk.koffi.unregister).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(fk.koffi.unregister).toHaveBeenCalledExactlyOnceWith(handle)
    api.removeZOrderGuard(SELF)
    expect(fb.b.RemoveWindowSubclass).toHaveBeenCalledTimes(1)
  })

  it('releases the callback and reports false when SetWindowSubclass fails', () => {
    fb.b.SetWindowSubclass.mockReturnValueOnce(false)
    const api = createApi()

    expect(api.installZOrderGuard(SELF, () => 'bottom')).toBe(false)
    vi.runAllTimers()
    expect(fk.koffi.unregister).toHaveBeenCalledTimes(1)
  })

  it('stands aside while seatAboveShell makes its own two-step move', () => {
    fb.order.splice(0, fb.order.length, SHELL, SELF)
    const api = createApi()
    api.installZOrderGuard(SELF, () => 'bottom')
    fk.koffi.encode.mockClear()

    api.seatAboveShell(SELF)

    expect(fb.b.SetWindowPos.mock.calls.map((call) => call[1])).toEqual([
      HWND_TOPMOST,
      HWND_NOTOPMOST
    ])
    expect(fk.koffi.encode).not.toHaveBeenCalled()
  })

  it('lets setTopmost go through the guard, which enforces the mode', () => {
    const api = createApi()
    api.installZOrderGuard(SELF, () => 'bottom')
    fk.koffi.encode.mockClear()

    api.setTopmost(SELF, true)

    expect(fk.koffi.encode).toHaveBeenCalledWith(expect.any(BigInt), 8, 'intptr_t', Number(APP))
  })
})

describe('SetWindowPos failures', () => {
  it('logs a failed z-order change once until it succeeds again', () => {
    const api = createApi()
    fb.failSetWindowPos(true)

    api.setTopmost(SELF, true)
    api.setTopmost(SELF, true)
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      `win32: SetWindowPos(0x${SELF.toString(16)}, topmost) failed`
    )

    fb.failSetWindowPos(false)
    api.setTopmost(SELF, true)
    fb.failSetWindowPos(true)
    api.setTopmost(SELF, true)
    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  it('logs a failed re-seat', () => {
    fb.order.splice(0, fb.order.length, SELF, APP, SHELL)
    fb.failSetWindowPos(true)

    createApi().seatAboveShell(SELF)

    expect(log.warn).toHaveBeenCalledWith(
      `win32: SetWindowPos(0x${SELF.toString(16)}, seat) failed`
    )
  })
})

describe('queries', () => {
  it('reports WS_EX_TOPMOST', () => {
    const api = createApi()
    fb.topmost.add(SELF)

    expect(api.isTopmost(SELF)).toBe(true)
    expect(api.isTopmost(APP)).toBe(false)
  })

  it('answers isAbove from the z-order', () => {
    const api = createApi()

    expect(api.isAbove(SELF, SHELL)).toBe(true)
    expect(api.isAbove(SHELL, SELF)).toBe(false)
  })
})

describe('rootWindowAtCursor (Phase 8 drag-out)', () => {
  it('is the top-level window (GetAncestor GA_ROOT) of the window under the cursor', () => {
    const CHILD = 0x201n
    const GetCursorPos = vi.fn((point: { x: number; y: number }) => {
      point.x = 640
      point.y = -12
      return true
    })
    const WindowFromPoint = vi.fn(() => CHILD)
    const GetAncestor = vi.fn(() => APP)
    Object.assign(fb.b, { GetCursorPos, WindowFromPoint, GetAncestor })
    const api = createApi()

    expect(api.rootWindowAtCursor()).toBe(APP)
    expect(WindowFromPoint).toHaveBeenCalledWith({ x: 640, y: -12 })
    expect(GetAncestor).toHaveBeenCalledWith(CHILD, GA_ROOT)
  })

  it('is null when the cursor position is unknown or no window is there', () => {
    Object.assign(fb.b, {
      GetCursorPos: vi.fn(() => false),
      WindowFromPoint: vi.fn(() => APP),
      GetAncestor: vi.fn(() => APP)
    })
    expect(createApi().rootWindowAtCursor()).toBeNull()

    Object.assign(fb.b, { GetCursorPos: vi.fn(() => true), WindowFromPoint: vi.fn(() => null) })
    expect(createApi().rootWindowAtCursor()).toBeNull()
  })
})

describe('allowSetForegroundWindow (native menus: the shell-menu helper)', () => {
  it('grants the process the right to take the foreground and reports whether Windows agreed', () => {
    const AllowSetForegroundWindow = vi.fn((pid: number) => pid === 4242)
    Object.assign(fb.b, { AllowSetForegroundWindow })
    const api = createApi()
    expect(api.allowSetForegroundWindow(4242)).toBe(true)
    expect(api.allowSetForegroundWindow(1)).toBe(false)
    expect(AllowSetForegroundWindow).toHaveBeenCalledWith(4242)
  })
})

describe('cancelMenu / desktopViewCommand / foregroundWindow (Phase 3: native menus)', () => {
  it('posts WM_CANCELMODE to the menu owner and reports whether Windows queued it', () => {
    const PostMessageW = vi.fn(() => true)
    Object.assign(fb.b, { PostMessageW })
    const api = createApi()
    expect(api.cancelMenu(0x5e11n)).toBe(true)
    expect(PostMessageW).toHaveBeenCalledWith(0x5e11n, WM_CANCELMODE, 0, 0)
    expect(WM_CANCELMODE).toBe(0x001f)
  })

  it('runs Undo and Paste through the desktop’s real view (WM_COMMAND to SHELLDLL_DefView)', () => {
    const PostMessageW = vi.fn(() => true)
    Object.assign(fb.b, { PostMessageW })
    const api = createApi()
    expect(api.desktopViewCommand('undo')).toBe(true)
    expect(api.desktopViewCommand('paste')).toBe(true)
    expect(PostMessageW.mock.calls).toEqual([
      [DEFVIEW, 0x0111, 0x701b, 0],
      [DEFVIEW, 0x0111, 0x701a, 0]
    ])
  })

  it('reports false when Explorer’s desktop view is not there', () => {
    const PostMessageW = vi.fn(() => true)
    Object.assign(fb.b, { PostMessageW, FindWindowExW: () => null })
    const api = createApi()
    expect(api.desktopViewCommand('paste')).toBe(false)
    expect(PostMessageW).not.toHaveBeenCalled()
  })

  it('answers the foreground window (GetForegroundWindow), null when there is none', () => {
    let foreground: Hwnd | null = APP
    Object.assign(fb.b, { GetForegroundWindow: vi.fn(() => foreground) })
    const api = createApi()
    expect(api.foregroundWindow()).toBe(APP)
    foreground = null
    expect(api.foregroundWindow()).toBeNull()
  })
})

describe('isPrimaryButtonDown (Phase 8 drag-out)', () => {
  it('reads the physical button that is primary: left, or right when the buttons are swapped', () => {
    const pressed = new Set<number>([VK_LBUTTON])
    let swapped = 0
    const GetAsyncKeyState = vi.fn((vk: number) => (pressed.has(vk) ? -32768 : 0))
    const GetSystemMetrics = vi.fn(() => swapped)
    Object.assign(fb.b, { GetAsyncKeyState, GetSystemMetrics })
    const api = createApi()

    expect(api.isPrimaryButtonDown()).toBe(true)
    expect(GetSystemMetrics).toHaveBeenCalledWith(SM_SWAPBUTTON)
    swapped = 1
    expect(api.isPrimaryButtonDown()).toBe(false)
    pressed.add(VK_RBUTTON)
    expect(api.isPrimaryButtonDown()).toBe(true)
  })
})

describe('regGetString', () => {
  const HKCU = 0x80000001 | 0

  it('retries with a larger buffer when the value grew between the two calls (ERROR_MORE_DATA)', () => {
    const text = 'C:\\Users\\me\\AppData\\Local\\Temp'
    const bytes = Buffer.from(`${text}\0`, 'utf16le')
    fb.b.RegGetValueW.mockImplementationOnce((...args: unknown[]) => {
      ;(args[6] as [number])[0] = 8
      return ERROR_SUCCESS
    })
      .mockImplementationOnce((...args: unknown[]) => {
        ;(args[6] as [number])[0] = bytes.length
        return ERROR_MORE_DATA
      })
      .mockImplementationOnce((...args: unknown[]) => {
        bytes.copy(args[5] as Buffer)
        ;(args[6] as [number])[0] = bytes.length
        return ERROR_SUCCESS
      })

    expect(createApi().regGetString('HKCU', 'Environment', 'TEMP')).toBe(text)
    expect(fb.b.RegGetValueW).toHaveBeenCalledTimes(3)
    expect(fb.b.RegGetValueW.mock.calls[0][0]).toBe(HKCU)
  })

  it('returns null for a missing key or value', () => {
    fb.b.RegGetValueW.mockReturnValue(ERROR_FILE_NOT_FOUND)

    expect(createApi().regGetString('HKLM', 'Software\\Nope', 'x')).toBeNull()
  })

  it('throws on any other failure', () => {
    fb.b.RegGetValueW.mockReturnValue(ERROR_ACCESS_DENIED)

    expect(() => createApi().regGetString('HKLM', 'SAM', 'x')).toThrow(
      'RegGetValueW(SAM\\x) failed with status 5'
    )
  })
})

describe('file system calls', () => {
  it('canModifyFolder opens the folder for add-file + delete-child access, then closes it', () => {
    const api = createApi()

    expect(api.canModifyFolder('C:\\Users\\me\\Desktop\\')).toBe(true)

    expect(fb.b.CreateFileW).toHaveBeenCalledExactlyOnceWith(
      '\\\\?\\C:\\Users\\me\\Desktop',
      FILE_ADD_FILE | FILE_DELETE_CHILD,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      null,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS,
      null
    )
    expect(fb.b.CloseHandle).toHaveBeenCalledExactlyOnceWith(0x2a4)
  })

  it('canModifyFolder is false when Windows refuses the handle (nothing to close)', () => {
    fb.b.CreateFileW.mockReturnValue(INVALID_HANDLE_VALUE)

    expect(createApi().canModifyFolder('C:\\Users\\Public\\Desktop')).toBe(false)
    expect(fb.b.CloseHandle).not.toHaveBeenCalled()
  })

  it('moveFile calls MoveFileExW on \\\\?\\ paths without MOVEFILE_REPLACE_EXISTING', () => {
    createApi().moveFile('C:\\d\\a.txt', 'C:\\d\\b.txt')

    expect(fb.b.MoveFileExW).toHaveBeenCalledExactlyOnceWith(
      '\\\\?\\C:\\d\\a.txt',
      '\\\\?\\C:\\d\\b.txt',
      0
    )
  })

  it('moveFile turns the Win32 error into a Node-style error code', () => {
    const cases: Array<[number, string]> = [
      [2, 'ENOENT'],
      [3, 'ENOENT'],
      [5, 'EPERM'],
      [17, 'EXDEV'],
      [32, 'EBUSY'],
      [80, 'EEXIST'],
      [183, 'EEXIST'],
      [123, 'EINVAL'],
      [206, 'ENAMETOOLONG'],
      [1234, 'EIO']
    ]
    const api = createApi()
    fb.b.MoveFileExW.mockReturnValue(false)
    for (const [win32Error, code] of cases) {
      fb.b.GetLastError.mockReturnValue(win32Error)
      expect(() => api.moveFile('C:\\a', 'C:\\b'), code).toThrow(
        expect.objectContaining({ code, errno: win32Error })
      )
    }
  })

  it('setHidden adds or removes FILE_ATTRIBUTE_HIDDEN and keeps the other attributes', () => {
    const api = createApi()
    fb.b.GetFileAttributesW.mockReturnValue(0x20)

    expect(api.setHidden('C:\\d\\x', true)).toBe(true)
    expect(fb.b.SetFileAttributesW).toHaveBeenLastCalledWith('\\\\?\\C:\\d\\x', 0x22)

    fb.b.GetFileAttributesW.mockReturnValue(0x02)
    expect(api.setHidden('C:\\d\\x', false)).toBe(true)
    // No attribute left: Windows wants FILE_ATTRIBUTE_NORMAL rather than 0.
    expect(fb.b.SetFileAttributesW).toHaveBeenLastCalledWith('\\\\?\\C:\\d\\x', 0x80)
  })

  it('setHidden reports false for a missing path or a refused change', () => {
    const api = createApi()
    fb.b.GetFileAttributesW.mockReturnValue(0xffffffff)
    expect(api.setHidden('C:\\gone', true)).toBe(false)
    expect(fb.b.SetFileAttributesW).not.toHaveBeenCalled()

    fb.b.GetFileAttributesW.mockReturnValue(0x20)
    fb.b.SetFileAttributesW.mockReturnValue(false)
    expect(api.setHidden('C:\\d\\x', true)).toBe(false)
  })
})

describe('getWallpaperForMonitor (Phase 6)', () => {
  it('asks the wallpaper reader for the monitor at that physical rect', () => {
    const wallpaper = vi.fn(() => ({ path: null, position: 'fit' as const, monitorIndex: 1 }))
    const api = createKoffiWin32Api(fk.koffi as unknown as Koffi, {
      log,
      bindings: fb.b as unknown as Win32Bindings,
      wallpaper
    })
    const rect = { x: 2560, y: 0, width: 1920, height: 1080 }
    expect(api.getWallpaperForMonitor(rect)).toEqual({
      path: null,
      position: 'fit',
      monitorIndex: 1
    })
    expect(wallpaper).toHaveBeenCalledWith(rect)
  })
})
