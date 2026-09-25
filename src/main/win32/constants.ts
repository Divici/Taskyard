/** Win32 constants used by Taskyard (values from the Windows SDK headers). */

// SetWindowPos hWndInsertAfter sentinels (intptr_t values).
export const HWND_TOP = 0
export const HWND_BOTTOM = 1
export const HWND_TOPMOST = -1
export const HWND_NOTOPMOST = -2

// SetWindowPos / WINDOWPOS flags.
export const SWP_NOSIZE = 0x0001
export const SWP_NOMOVE = 0x0002
export const SWP_NOZORDER = 0x0004
export const SWP_NOACTIVATE = 0x0010

/** Change only the z-order: no move, no resize, no activation. */
export const SWP_ZORDER_ONLY = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE

// ShowWindow commands.
export const SW_SHOWNOACTIVATE = 4

// GetWindow commands.
export const GW_HWNDNEXT = 2
/** GetAncestor: the root window (walks the parent chain, not the owner). */
export const GA_ROOT = 2
/** GetSystemMetrics: non-zero when the left and right mouse buttons are swapped. */
export const SM_SWAPBUTTON = 23
/** Virtual keys of the physical left and right mouse buttons (GetAsyncKeyState). */
export const VK_LBUTTON = 0x01
export const VK_RBUTTON = 0x02
export const GW_HWNDPREV = 3

// Window long indices and extended styles.
export const GWL_EXSTYLE = -20
export const WS_EX_TOPMOST = 0x00000008
export const WS_EX_TOOLWINDOW = 0x00000080
export const WS_EX_APPWINDOW = 0x00040000

// DwmGetWindowAttribute: non-zero for windows on other virtual desktops or suspended apps.
export const DWMWA_CLOAKED = 14

// Messages.
export const WM_WINDOWPOSCHANGING = 0x0046
export const WM_NCDESTROY = 0x0082
export const WM_SYSCOMMAND = 0x0112

// WM_SYSCOMMAND commands; the low 4 bits of wParam are used by Windows itself.
export const SC_COMMAND_MASK = 0xfff0
export const SC_MINIMIZE = 0xf020
export const SC_CLOSE = 0xf060

// WinEvents.
export const EVENT_SYSTEM_FOREGROUND = 0x0003
export const WINEVENT_OUTOFCONTEXT = 0x0000

// GetFileAttributesW.
export const INVALID_FILE_ATTRIBUTES = 0xffffffff
export const FILE_ATTRIBUTE_READONLY = 0x00000001
export const FILE_ATTRIBUTE_HIDDEN = 0x00000002
export const FILE_ATTRIBUTE_SYSTEM = 0x00000004
export const FILE_ATTRIBUTE_DIRECTORY = 0x00000010
export const FILE_ATTRIBUTE_OFFLINE = 0x00001000
export const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000

export const FILE_ATTRIBUTE_NORMAL = 0x00000080

// CreateFileW (canModifyFolder): directory access rights, sharing, disposition, flags.
export const FILE_ADD_FILE = 0x0002
export const FILE_DELETE_CHILD = 0x0040
export const FILE_SHARE_READ = 0x1
export const FILE_SHARE_WRITE = 0x2
export const FILE_SHARE_DELETE = 0x4
export const OPEN_EXISTING = 3
/** Required to open a directory handle. */
export const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
/** `(HANDLE)-1` as koffi returns an `intptr_t`. */
export const INVALID_HANDLE_VALUE = -1

// Win32 error codes (GetLastError) that file operations map to Node-style codes.
export const WIN32_ERROR_CODES: Readonly<Record<number, string>> = {
  2: 'ENOENT', // ERROR_FILE_NOT_FOUND
  3: 'ENOENT', // ERROR_PATH_NOT_FOUND
  5: 'EPERM', // ERROR_ACCESS_DENIED
  17: 'EXDEV', // ERROR_NOT_SAME_DEVICE
  19: 'EPERM', // ERROR_WRITE_PROTECT
  32: 'EBUSY', // ERROR_SHARING_VIOLATION
  33: 'EBUSY', // ERROR_LOCK_VIOLATION
  80: 'EEXIST', // ERROR_FILE_EXISTS
  123: 'EINVAL', // ERROR_INVALID_NAME
  183: 'EEXIST', // ERROR_ALREADY_EXISTS
  206: 'ENAMETOOLONG' // ERROR_FILENAME_EXCED_RANGE
}

// Registry. Predefined HKEYs are sign-extended 32-bit values: pass them as intptr_t.
export const HKEY_CURRENT_USER = 0x80000001 | 0
export const HKEY_LOCAL_MACHINE = 0x80000002 | 0
export const RRF_RT_REG_SZ = 0x00000002
export const ERROR_SUCCESS = 0
export const ERROR_FILE_NOT_FOUND = 2
export const ERROR_ACCESS_DENIED = 5
export const ERROR_PATH_NOT_FOUND = 3
export const ERROR_MORE_DATA = 234

// SystemParametersInfoW actions (Phase 6 reads the wallpaper path with it).
export const SPI_GETDESKWALLPAPER = 0x0073

// Desktop window class names.
export const PROGMAN_CLASS = 'Progman'
export const WORKERW_CLASS = 'WorkerW'
export const DEFVIEW_CLASS = 'SHELLDLL_DefView'

// GetDriveTypeW (Phase 5 review fix: icon sources on mapped network drives are never read).
export const DRIVE_UNKNOWN = 0
export const DRIVE_NO_ROOT_DIR = 1
export const DRIVE_REMOVABLE = 2
export const DRIVE_FIXED = 3
export const DRIVE_REMOTE = 4
