import type { WallpaperPosition } from '@shared/wallpaper-geometry'

/**
 * The Win32 surface Taskyard needs, behind one interface so every unit test runs headless:
 * `koffi-api.ts` implements it with real DLL calls, `fake-api.ts` with an in-memory model.
 */

/** A window handle (HWND) as an unsigned integer — the form koffi 3 uses for pointers. */
export type Hwnd = bigint

/**
 * Where the z-order guard keeps a desktop window: `bottom` = directly above the shell desktop
 * window (normal), `peek` = topmost, directly below the taskbars (raised over every app; Phase 12
 * keeps Start, the clock and the tray usable above it).
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

/** IDesktopWallpaper's DESKTOP_WALLPAPER_POSITION, by name (shared with the renderer's geometry). */
export type { WallpaperPosition }

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

/** Phase 3: DefView commands Taskyard runs through Explorer's own desktop view. */
export type DesktopViewCommand = 'undo' | 'paste'

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
  /**
   * Phase 12: `hwnd` is part of using Taskyard's tray icon — a taskbar (`Shell_TrayWnd`,
   * `Shell_SecondaryTrayWnd`), the tray's overflow flyout, or a window of Taskyard's own process
   * (Electron's tray icon host, which takes the foreground while the tray menu is open). Pressing
   * the icon focuses one of these before the click lands, so a Peek must not end on it.
   */
  isTrayWindow(hwnd: Hwnd): boolean
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
  /**
   * The top-level window under the mouse cursor (`GetCursorPos` → `WindowFromPoint` →
   * `GetAncestor(GA_ROOT)`), or null. Phase 8: an item drag hands over to the OS drag when the
   * cursor is over another app's window (which sits above the desktop window).
   */
  rootWindowAtCursor(): Hwnd | null
  /**
   * Whether the primary mouse button is physically down now (`GetAsyncKeyState` of the left
   * button, or the right one when `SM_SWAPBUTTON` swaps them). Phase 8: the OS drag only starts
   * while it is — never from touch, pen or synthetic input, where Windows' drag loop would drop
   * at once wherever the cursor happens to be.
   */
  isPrimaryButtonDown(): boolean
  /**
   * `AllowSetForegroundWindow(pid)`: lets process `pid` take the foreground. Native menus: the
   * shell-menu helper process must own the foreground while its popup menu is open (or the menu
   * never closes on an outside click), and only a process that has the foreground itself
   * (Taskyard, right after the user's right-click) may grant that. False when Windows refused.
   */
  allowSetForegroundWindow(pid: number): boolean
  /**
   * Phase 3: `PostMessage(owner, WM_CANCELMODE)` — closes the popup menu `owner` is tracking (the
   * shell-menu helper's, when the user right-clicks again). False when Windows refused the post
   * (e.g. the window is gone).
   */
  cancelMenu(owner: Hwnd): boolean
  /**
   * Phase 3: `GetForegroundWindow()`, or null. When a native menu closes, Peek judges the window
   * that has the foreground then (another app's ends it).
   */
  foregroundWindow(): Hwnd | null
  /**
   * Phase 3: the native desktop menu's "Undo …" and "Paste" — posts DefView's command to
   * Explorer's own desktop view (`SHELLDLL_DefView` under the shell window): Undo runs the shell's
   * shared Undo (like Ctrl+Z on the desktop), Paste pastes into the user's Desktop folder. The
   * windowless view Taskyard's menu comes from ignores both. False when Explorer's desktop view is
   * not there.
   */
  desktopViewCommand(command: DesktopViewCommand): boolean
  /** `GetFileAttributesW` on the `\\?\` form of `path`; null when the path cannot be read. */
  getFileAttributes(path: string): number | null
  /**
   * Whether this user may add and delete entries in `dir`: opens it with
   * `FILE_ADD_FILE | FILE_DELETE_CHILD` (an ACL access check, no side effects) and closes it.
   * Node's `fs.access(W_OK)` ignores ACLs on Windows, so it cannot tell that a standard user may
   * not change the Public Desktop. False when the folder is missing too.
   */
  canModifyFolder(dir: string): boolean
  /**
   * Renames or moves `from` to `to` (`MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` or
   * `MOVEFILE_COPY_ALLOWED`): never replaces an existing file, never copies. A case-only rename
   * of the same file is allowed. Throws an Error with a Node-style `code` (`EEXIST`, `EXDEV`,
   * `EPERM`, `EBUSY`, `ENOENT`, `ENAMETOOLONG`, `EINVAL`, else `EIO`) and the Win32 `errno`.
   */
  moveFile(from: string, to: string): void
  /** Sets or clears `FILE_ATTRIBUTE_HIDDEN`, keeping the other attributes; false on failure. */
  setHidden(path: string, hidden: boolean): boolean
  /** A `REG_SZ`/`REG_EXPAND_SZ` (expanded) value, or null when the key or value is missing. */
  regGetString(hive: RegistryHive, key: string, value: string): string | null
  /**
   * The wallpaper Windows paints on the monitor whose RECT matches `rectPx` (IDesktopWallpaper;
   * falls back to `SPI_GETDESKWALLPAPER` + `WallpaperStyle`/`TileWallpaper` when COM fails or no
   * monitor matches). Read only: Taskyard never changes the user's wallpaper.
   */
  getWallpaperForMonitor(rectPx: PixelRect): MonitorWallpaper | null
  /**
   * `GetDriveTypeW` of a drive root such as `Z:\` (`DRIVE_REMOTE` = 4 for a mapped network drive).
   * Answers from the drive table without touching the drive (Phase 5: icon sources on network
   * drives are never read).
   */
  getDriveType(root: string): number
  /** Icon `index` of `file` at `px`×`px`. Implemented in Phase 5. */
  extractIcon(file: string, index: number, px: number): IconBitmap | null
}
