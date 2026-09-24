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
