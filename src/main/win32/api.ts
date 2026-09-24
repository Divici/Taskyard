/**
 * The Win32 surface Taskyard needs, behind one interface so every unit test runs headless:
 * `koffi-api.ts` implements it with real DLL calls, `fake-api.ts` with an in-memory model.
 */

/** A window handle (HWND) as an unsigned integer — the form koffi 3 uses for pointers. */
export type Hwnd = bigint

/**
 * Where the z-order guard keeps a desktop window: `bottom` = directly above the shell desktop
 * window (normal), `peek` = `HWND_TOPMOST` (raised over every app).
 */
export type ZOrderMode = 'bottom' | 'peek'

export type RegistryHive = 'HKCU' | 'HKLM'

/** A rectangle in physical pixels (Win32 coordinates, not Electron DIPs). */
export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

/** IDesktopWallpaper's DESKTOP_WALLPAPER_POSITION, by name. */
export type WallpaperPosition = 'center' | 'tile' | 'stretch' | 'fit' | 'fill' | 'span'

/** What Windows paints on one monitor (Phase 6 reads it through IDesktopWallpaper). */
export interface MonitorWallpaper {
  /** Image path, or null for a solid-colour desktop. */
  path: string | null
  position: WallpaperPosition
  /** Index among IDesktopWallpaper's monitors — selects the `Transcoded_00N` cache file. */
  monitorIndex: number
}

/**
 * Raw icon pixels as `GetDIBits` returns them: 32-bpp, top-down rows, BGRA with straight alpha.
 * `mask` is the AND mask rendered the same way, for legacy icons whose alpha is all zero
 * (Phase 5 premultiplies and derives alpha from it).
 */
export interface IconBitmap {
  width: number
  height: number
  bgra: Buffer
  mask: Buffer | null
}

export type Unsubscribe = () => void

export interface Win32Api {
  /** Moves `hwnd` directly above the shell desktop window (no activation, no move/resize). */
  seatAboveShell(hwnd: Hwnd): void
  /** `HWND_TOPMOST` when on, `HWND_NOTOPMOST` when off (the guard may rewrite the latter). */
  setTopmost(hwnd: Hwnd, on: boolean): void
  /** `ShowWindow(SW_SHOWNOACTIVATE)` — shows (or un-minimizes) without taking focus. */
  showNoActivate(hwnd: Hwnd): void
  /**
   * Subclasses `hwnd` so every `WM_WINDOWPOSCHANGING` without `SWP_NOZORDER` is rewritten to
   * the z-order `mode()` asks for. The same subclass swallows Alt+F4 (`WM_SYSCOMMAND` /
   * `SC_CLOSE`): the user cannot close the desktop layer, while a raw `WM_CLOSE` from another
   * app still arrives (and quits the app gracefully). Returns false when it cannot be installed.
   */
  installZOrderGuard(hwnd: Hwnd, mode: () => ZOrderMode): boolean
  /** Removes the guard and releases its callback. Safe to call twice. */
  removeZOrderGuard(hwnd: Hwnd): void
  /** Calls `cb` with the new foreground window after every `EVENT_SYSTEM_FOREGROUND`. */
  watchForeground(cb: (hwnd: Hwnd | null) => void): Unsubscribe
  /**
   * The top-level window that hosts the desktop icons (`SHELLDLL_DefView`): Progman, or the
   * WorkerW it detached into. Re-resolved on every call — Explorer restarts create new handles.
   * Null while Explorer is not running.
   */
  getShellWindow(): Hwnd | null
  /** True when `hwndA` is higher in the z-order than `hwndB`. */
  isAbove(hwndA: Hwnd, hwndB: Hwnd): boolean
  /** `WS_EX_TOPMOST` is set: the window is in the always-on-top band. */
  isTopmost(hwnd: Hwnd): boolean
  /**
   * The windows strictly between `upper` and `lower` that someone could see if `upper` did not
   * cover them: visible, not minimized, not DWM-cloaked (other virtual desktops) and not empty.
   * Empty when `upper` is not above `lower`. Explorer restores windows here after Win+D.
   */
  visibleWindowsBetween(upper: Hwnd, lower: Hwnd): Hwnd[]
  /** `GetFileAttributesW` on the `\\?\` form of `path`; null when the path cannot be read. */
  getFileAttributes(path: string): number | null
  /** A `REG_SZ`/`REG_EXPAND_SZ` (expanded) value, or null when the key or value is missing. */
  regGetString(hive: RegistryHive, key: string, value: string): string | null
  /** The wallpaper Windows paints on the monitor at `rectPx`. Implemented in Phase 6. */
  getWallpaperForMonitor(rectPx: PixelRect): MonitorWallpaper | null
  /** Icon `index` of `file` at `px`×`px`. Implemented in Phase 5. */
  extractIcon(file: string, index: number, px: number): IconBitmap | null
}
