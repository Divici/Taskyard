import type { Hwnd, PixelRect, RegistryHive, Unsubscribe, Win32Api, ZOrderMode } from './api'
import { loadWin32Bindings, type CallbackHandle, type Koffi, type Win32Bindings } from './bindings'
import { createComRuntime, loadOle32 } from './com'
import {
  ERROR_FILE_NOT_FOUND,
  ERROR_MORE_DATA,
  ERROR_PATH_NOT_FOUND,
  ERROR_SUCCESS,
  EVENT_SYSTEM_FOREGROUND,
  FILE_ADD_FILE,
  FILE_ATTRIBUTE_HIDDEN,
  FILE_ATTRIBUTE_NORMAL,
  FILE_DELETE_CHILD,
  FILE_FLAG_BACKUP_SEMANTICS,
  FILE_SHARE_DELETE,
  FILE_SHARE_READ,
  FILE_SHARE_WRITE,
  INVALID_HANDLE_VALUE,
  OPEN_EXISTING,
  WIN32_ERROR_CODES,
  GA_ROOT,
  SM_SWAPBUTTON,
  VK_LBUTTON,
  VK_RBUTTON,
  GW_HWNDNEXT,
  GW_HWNDPREV,
  HKEY_CURRENT_USER,
  HKEY_LOCAL_MACHINE,
  HWND_NOTOPMOST,
  HWND_TOPMOST,
  INVALID_FILE_ATTRIBUTES,
  RRF_RT_REG_SZ,
  SW_SHOWNOACTIVATE,
  SWP_ZORDER_ONLY,
  WINEVENT_OUTOFCONTEXT,
  SC_CLOSE,
  SC_COMMAND_MASK,
  SPI_GETDESKWALLPAPER,
  WM_NCDESTROY,
  WM_SYSCOMMAND,
  WM_WINDOWPOSCHANGING
} from './constants'
import { extractIconWith, loadIconBindings, type IconBindings } from './extract-icon'
import { toExtendedLengthPath } from './long-path'
import { resolveShellWindow, type WindowTree } from './shell-window'
import {
  createDesktopWallpaperReader,
  createMonitorWallpaperReader,
  desktopWallpaperProtos,
  type LegacyWallpaper
} from './wallpaper'
import {
  guardTarget,
  isAboveInZOrder,
  MAX_Z_ORDER_STEPS,
  rewriteWindowPos,
  seatSteps,
  seatTarget,
  type ZOrderProbe
} from './z-order'

export interface Win32Log {
  warn(message: string, ...details: unknown[]): void
  error(message: string, ...details: unknown[]): void
}

export interface KoffiWin32ApiOptions {
  log: Win32Log
  /** Injected in headless tests; loaded from the real DLLs otherwise. */
  bindings?: Win32Bindings
  /** Phase 6: injected in headless tests; IDesktopWallpaper over COM (wallpaper.ts) otherwise. */
  wallpaper?: (rectPx: PixelRect) => ReturnType<Win32Api['getWallpaperForMonitor']>
  /** Phase 5 icon extraction calls; injected in headless tests, loaded on first use otherwise. */
  iconBindings?: IconBindings
}

/** `uIdSubclass` for Taskyard's guard ('Ty'); one guard per window. */
export const GUARD_SUBCLASS_ID = 0x5479

const HKEYS: Record<RegistryHive, number> = {
  HKCU: HKEY_CURRENT_USER,
  HKLM: HKEY_LOCAL_MACHINE
}

interface Guard {
  callback: CallbackHandle
  failures: number
}

/** `Win32Api` over real user32/comctl32/advapi32/kernel32 calls through koffi. */
export function createKoffiWin32Api(koffi: Koffi, options: KoffiWin32ApiOptions): Win32Api {
  const { log, bindings } = options
  let iconBindings = options.iconBindings
  const b = bindings ?? loadWin32Bindings(koffi)
  let wallpaper = options.wallpaper
  const guards = new Map<Hwnd, Guard>()
  /** `hwnd|what` of z-order changes whose failure was already logged (until one succeeds). */
  const failing = new Set<string>()

  const setWindowPos = (hwnd: Hwnd, insertAfter: number, what: string): void => {
    const key = `${hwnd}|${what}`
    if (b.SetWindowPos(hwnd, insertAfter, 0, 0, 0, 0, SWP_ZORDER_ONLY)) {
      failing.delete(key)
    } else if (!failing.has(key)) {
      failing.add(key)
      log.warn(`win32: SetWindowPos(0x${hwnd.toString(16)}, ${what}) failed`)
    }
  }
  /** Windows whose guard stands aside while seatAboveShell runs its own multi-step move. */
  const unguarded = new Set<Hwnd>()

  const probe: ZOrderProbe = {
    windowAbove: (hwnd) => b.GetWindow(hwnd, GW_HWNDPREV),
    windowBelow: (hwnd) => b.GetWindow(hwnd, GW_HWNDNEXT),
    isTopmost: (hwnd) => b.isTopmost(hwnd)
  }
  const tree: WindowTree = {
    getShellWindow: () => b.GetShellWindow(),
    findWindow: (parent, after, className) => b.FindWindowExW(parent, after, className, null)
  }
  const getShellWindow = (): Hwnd | null => resolveShellWindow(tree)
  /** Phase 12: the tray's overflow flyout (Windows 11, then Windows 10), when it exists. */
  const trayOverflow = (): Hwnd[] =>
    ['TopLevelWindowForOverflowXamlIsland', 'NotifyIconOverflowWindow']
      .map((className) => b.FindWindowExW(null, null, className, null))
      .filter((hwnd): hwnd is Hwnd => hwnd !== null)
  /** Phase 12: every taskbar (primary and per-monitor), which a Peek stays below. */
  const taskbars = (): Hwnd[] => {
    const found: Hwnd[] = []
    const primary = b.FindWindowExW(null, null, 'Shell_TrayWnd', null)
    if (primary !== null) found.push(primary)
    for (
      let hwnd = b.FindWindowExW(null, null, 'Shell_SecondaryTrayWnd', null);
      hwnd !== null && found.length < 16;
      hwnd = b.FindWindowExW(null, hwnd, 'Shell_SecondaryTrayWnd', null)
    ) {
      found.push(hwnd)
    }
    return found
  }

  // A callback may be the one currently on the stack (a window closed from inside its own
  // message), so it is released on a later turn; until then it stays referenced.
  const releaseLater = (callback: CallbackHandle): void => {
    setImmediate(() => koffi.unregister(callback))
  }

  const removeZOrderGuard = (hwnd: Hwnd): void => {
    const guard = guards.get(hwnd)
    if (guard === undefined) return
    guards.delete(hwnd)
    b.RemoveWindowSubclass(hwnd, guard.callback, GUARD_SUBCLASS_ID)
    releaseLater(guard.callback)
  }

  const guardWindowPos = (hwnd: Hwnd, lParam: number, mode: ZOrderMode): void => {
    const pointer = BigInt(lParam)
    const pos = koffi.decode(pointer, b.WINDOWPOS) as { hwndInsertAfter: number; flags: number }
    const target = guardTarget(
      mode,
      hwnd,
      getShellWindow(),
      probe,
      mode === 'peek' ? taskbars() : []
    )
    const next = rewriteWindowPos(pos, target)
    if (next === null) return
    koffi.encode(
      pointer,
      koffi.offsetof(b.WINDOWPOS, 'hwndInsertAfter'),
      'intptr_t',
      next.hwndInsertAfter
    )
    koffi.encode(pointer, koffi.offsetof(b.WINDOWPOS, 'flags'), 'uint32_t', next.flags)
  }

  return {
    seatAboveShell(hwnd) {
      const steps = seatSteps(seatTarget(hwnd, getShellWindow(), probe))
      unguarded.add(hwnd)
      try {
        for (const insertAfter of steps) setWindowPos(hwnd, insertAfter, 'seat')
      } finally {
        unguarded.delete(hwnd)
      }
    },

    setTopmost(hwnd, on) {
      setWindowPos(hwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, on ? 'topmost' : 'not topmost')
    },

    showNoActivate(hwnd) {
      b.ShowWindow(hwnd, SW_SHOWNOACTIVATE)
    },

    installZOrderGuard(hwnd, mode) {
      removeZOrderGuard(hwnd)
      const guard: Guard = { callback: 0n, failures: 0 }
      guard.callback = koffi.register(
        (self: Hwnd, message: number, wParam: number, lParam: number): number | bigint => {
          try {
            if (message === WM_SYSCOMMAND && (Number(wParam) & SC_COMMAND_MASK) === SC_CLOSE) {
              return 0 // Alt+F4 on the desktop layer does nothing
            }
            if (message === WM_WINDOWPOSCHANGING && lParam && !unguarded.has(self)) {
              guardWindowPos(self, lParam, mode())
            } else if (message === WM_NCDESTROY) {
              removeZOrderGuard(self)
            }
          } catch (error) {
            // Never let an exception skip DefSubclassProc: the window must keep working.
            if (guard.failures++ === 0) log.warn('win32: z-order guard failed', error)
          }
          return b.DefSubclassProc(self, message, wParam, lParam)
        },
        b.SubclassProc
      )
      if (!b.SetWindowSubclass(hwnd, guard.callback, GUARD_SUBCLASS_ID, 0)) {
        releaseLater(guard.callback)
        return false
      }
      guards.set(hwnd, guard)
      return true
    },

    removeZOrderGuard,

    watchForeground(cb): Unsubscribe {
      const callback = koffi.register((_hook: bigint, _event: number, hwnd: Hwnd | null) => {
        try {
          cb(hwnd)
        } catch (error) {
          log.error('win32: foreground listener failed', error)
        }
      }, b.WinEventProc)
      const hook = b.SetWinEventHook(
        EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_FOREGROUND,
        null,
        callback,
        0,
        0,
        WINEVENT_OUTOFCONTEXT
      )
      if (hook === null) {
        releaseLater(callback)
        throw new Error('SetWinEventHook(EVENT_SYSTEM_FOREGROUND) failed')
      }
      let active = true
      return () => {
        if (!active) return
        active = false
        b.UnhookWinEvent(hook)
        releaseLater(callback)
      }
    },

    getShellWindow,

    isTrayWindow: (hwnd) =>
      taskbars().includes(hwnd) ||
      trayOverflow().includes(hwnd) ||
      b.processIdOf(hwnd) === process.pid,

    isAbove: (hwndA, hwndB) => isAboveInZOrder(hwndA, hwndB, probe),

    isTopmost: (hwnd) => b.isTopmost(hwnd),

    visibleWindowsBetween(upper, lower) {
      const found: Hwnd[] = []
      let current = probe.windowBelow(upper)
      for (let step = 0; current !== null && step < MAX_Z_ORDER_STEPS; step++) {
        if (current === lower) return found
        if (b.isOnScreen(current)) found.push(current)
        current = probe.windowBelow(current)
      }
      return []
    },

    rootWindowAtCursor() {
      const point = { x: 0, y: 0 }
      if (!b.GetCursorPos(point)) return null
      const hit = b.WindowFromPoint(point)
      return hit === null ? null : (b.GetAncestor(hit, GA_ROOT) ?? hit)
    },

    allowSetForegroundWindow: (pid) => b.AllowSetForegroundWindow(pid),

    isPrimaryButtonDown() {
      const vk = b.GetSystemMetrics(SM_SWAPBUTTON) !== 0 ? VK_RBUTTON : VK_LBUTTON
      return (b.GetAsyncKeyState(vk) & 0x8000) !== 0
    },

    getFileAttributes(path) {
      const attributes = b.GetFileAttributesW(toExtendedLengthPath(path))
      return attributes === INVALID_FILE_ATTRIBUTES ? null : attributes
    },

    canModifyFolder(dir) {
      const handle = b.CreateFileW(
        toExtendedLengthPath(dir),
        FILE_ADD_FILE | FILE_DELETE_CHILD,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        null,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
        null
      )
      if (Number(handle) === INVALID_HANDLE_VALUE) return false
      b.CloseHandle(handle)
      return true
    },

    moveFile(from, to) {
      if (b.MoveFileExW(toExtendedLengthPath(from), toExtendedLengthPath(to), 0)) return
      const errno = b.GetLastError()
      const code = WIN32_ERROR_CODES[errno] ?? 'EIO'
      throw Object.assign(
        new Error(`${code}: MoveFileExW failed with Win32 error ${errno}, '${from}' -> '${to}'`),
        { code, errno, syscall: 'MoveFileExW', path: from, dest: to }
      )
    },

    setHidden(path, hidden) {
      const extended = toExtendedLengthPath(path)
      const current = b.GetFileAttributesW(extended)
      if (current === INVALID_FILE_ATTRIBUTES) return false
      const next = hidden ? current | FILE_ATTRIBUTE_HIDDEN : current & ~FILE_ATTRIBUTE_HIDDEN
      return b.SetFileAttributesW(extended, next === 0 ? FILE_ATTRIBUTE_NORMAL : next >>> 0)
    },

    regGetString: (hive, key, value) => readRegistryString(b, HKEYS[hive], key, value),

    // Phase 6: wallpaper (read only).
    getWallpaperForMonitor: (rectPx) => (wallpaper ??= wallpaperReader(koffi, b, log))(rectPx),

    // Phase 5: user32/gdi32 icon extraction and the drive type (src/main/win32/extract-icon.ts).
    getDriveType(root) {
      iconBindings ??= loadIconBindings(koffi)
      return iconBindings.GetDriveTypeW(root)
    },

    extractIcon(file, index, px) {
      iconBindings ??= loadIconBindings(koffi)
      return extractIconWith(iconBindings, file, index, px)
    }
  }
}

const MAX_REGISTRY_ATTEMPTS = 4

/** `RegGetValueW(RRF_RT_REG_SZ)`: REG_SZ as-is, REG_EXPAND_SZ expanded; null when missing. */
function readRegistryString(
  b: Win32Bindings,
  hkey: number,
  key: string,
  value: string
): string | null {
  const size: [number] = [0]
  let status = b.RegGetValueW(hkey, key, value, RRF_RT_REG_SZ, null, null, size)
  for (let attempt = 0; attempt < MAX_REGISTRY_ATTEMPTS; attempt++) {
    if (status === ERROR_FILE_NOT_FOUND || status === ERROR_PATH_NOT_FOUND) return null
    if (status !== ERROR_SUCCESS && status !== ERROR_MORE_DATA) break
    const data = Buffer.alloc(size[0])
    status = b.RegGetValueW(hkey, key, value, RRF_RT_REG_SZ, null, data, size)
    // ERROR_MORE_DATA: the value grew between the two calls; size now holds the new length.
    if (status === ERROR_SUCCESS) return data.toString('utf16le', 0, size[0]).replace(/\0+$/, '')
  }
  throw new Error(`RegGetValueW(${key}\\${value}) failed with status ${status}`)
}

// ---------------------------------------------------------------------------------------------
// Phase 6: wallpaper

/** MAX_PATH UTF-16 characters: what SPI_GETDESKWALLPAPER can return. */
const DESK_WALLPAPER_CHARS = 260

/** SPI_GETDESKWALLPAPER + WallpaperStyle/TileWallpaper: the pre-IDesktopWallpaper answer. */
function readLegacyWallpaper(b: Win32Bindings): LegacyWallpaper {
  const buffer = Buffer.alloc(DESK_WALLPAPER_CHARS * 2)
  const path = b.SystemParametersInfoW(SPI_GETDESKWALLPAPER, DESK_WALLPAPER_CHARS, buffer, 0)
    ? buffer.toString('utf16le').replace(/\0[\s\S]*$/, '')
    : null
  const desktop = (value: string): string | null =>
    readRegistryString(b, HKEY_CURRENT_USER, 'Control Panel\\Desktop', value)
  return { path, style: desktop('WallpaperStyle'), tile: desktop('TileWallpaper') }
}

/** IDesktopWallpaper per monitor (COM, created on first use), falling back to the legacy read. */
function wallpaperReader(
  koffi: Koffi,
  b: Win32Bindings,
  log: Win32Log
): (rectPx: PixelRect) => ReturnType<Win32Api['getWallpaperForMonitor']> {
  return createMonitorWallpaperReader({
    reader: () =>
      createDesktopWallpaperReader(
        createComRuntime(koffi, loadOle32(koffi)),
        desktopWallpaperProtos(koffi)
      ),
    legacy: () => readLegacyWallpaper(b),
    log
  })
}
