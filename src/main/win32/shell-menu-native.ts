import type { Koffi } from './bindings'
import { parseGuid } from './com'

/**
 * The native declarations behind shell-menu-koffi.ts: COM interface ids and vtable slots, Win32
 * constants, the x64 structs (named koffi types; see `namedType`), the DLL functions and the
 * COM method prototypes. Values from the Windows SDK (ShObjIdl_core.h, WinUser.h, WinReg.h),
 * checked in shell-menu-koffi.win32.test.ts. No behaviour lives here.
 */

export const IID_ISHELLFOLDER = '{000214E6-0000-0000-C000-000000000046}'
export const IID_ISHELLVIEW = '{000214E3-0000-0000-C000-000000000046}'
export const IID_ICONTEXTMENU = '{000214E4-0000-0000-C000-000000000046}'
export const IID_ICONTEXTMENU2 = '{000214F4-0000-0000-C000-000000000046}'
export const IID_ICONTEXTMENU3 = '{BCFCE0A0-EC17-11D0-8D10-00A0C90F2719}'

/** Vtable slots (IUnknown is 0–2). */
export const SHELL_FOLDER = { BindToObject: 5, CreateViewObject: 8, GetUIObjectOf: 10 } as const
export const SHELL_VIEW = { GetItemObject: 15 } as const
/** IDropTarget: DragEnter 3, DragOver 4, DragLeave 5, Drop 6. */
export const DROP_TARGET = { DragEnter: 3, DragLeave: 5 } as const
export const IID_IDROPTARGET = '{00000122-0000-0000-C000-000000000046}'
export const DROPEFFECT_COPY = 0x1
export const DROPEFFECT_MOVE = 0x2
export const DROPEFFECT_LINK = 0x4
export const CONTEXT_MENU = {
  QueryContextMenu: 3,
  InvokeCommand: 4,
  GetCommandString: 5,
  HandleMenuMsg: 6,
  HandleMenuMsg2: 7
} as const

export const SVGIO_BACKGROUND = 0
export const GCS_VERBA = 0
export const GCS_VERBW = 4
export const VERB_CHARS = 260

export const WM_NULL = 0x0000
export const WM_DRAWITEM = 0x002b
export const WM_MEASUREITEM = 0x002c
export const WM_INITMENUPOPUP = 0x0117
export const WM_MENUCHAR = 0x0120
/** The owner-window messages IContextMenu2/3 handle while a menu is open. */
export const MENU_MESSAGES = new Set([WM_INITMENUPOPUP, WM_DRAWITEM, WM_MEASUREITEM, WM_MENUCHAR])

export const MIIM_STATE = 0x1
export const MIIM_ID = 0x2
export const MIIM_SUBMENU = 0x4
export const MIIM_STRING = 0x40
export const MIIM_FTYPE = 0x100
export const MFT_STRING = 0x0
export const MFT_SEPARATOR = 0x800
export const MFT_RADIOCHECK = 0x200
/** EnableMenuItem: by command id; enabled or grayed. */
export const MF_BYCOMMAND = 0x0
export const MF_ENABLED = 0x0
export const MF_GRAYED = 0x1
export const MFS_DISABLED = 0x3
export const MFS_CHECKED = 0x8
export const MF_BYPOSITION = 0x400
export const TPM_RIGHTBUTTON = 0x2
export const TPM_RETURNCMD = 0x100
export const PM_REMOVE = 0x1

export const CMIC_MASK_UNICODE = 0x4000
export const CMIC_MASK_SHIFT_DOWN = 0x10000000
export const CMIC_MASK_PTINVOKE = 0x20000000
export const CMIC_MASK_CONTROL_DOWN = 0x40000000
export const SW_SHOWNORMAL = 1
export const VK_SHIFT = 0x10
export const VK_CONTROL = 0x11

export const WS_POPUP = 0x80000000 | 0
export const WS_EX_TOOLWINDOW = 0x80
export const HKEY_CLASSES_ROOT = 0x80000000 | 0
export const KEY_READ = 0x20019

/** Registry keys whose handlers make up a background menu (for `default-menu`). */
export const BACKGROUND_KEYS = {
  desktop: ['DesktopBackground', 'Directory\\Background'],
  folder: ['Directory\\Background']
} as const

export type KoffiType = ReturnType<Koffi['type']>

export interface ShellMenuStructs {
  POINT: KoffiType
  MENUITEMINFOW: KoffiType
  /** MENUITEMINFOW with `dwTypeData` as a string, for inserting items. */
  MENUITEMINFOW_TEXT: KoffiType
  /** CMINVOKECOMMANDINFOEX invoking by command offset (MAKEINTRESOURCE in lpVerb/lpVerbW). */
  CMINVOKECOMMANDINFOEX_ID: KoffiType
  /** CMINVOKECOMMANDINFOEX invoking by verb string. */
  CMINVOKECOMMANDINFOEX_VERB: KoffiType
  DEFCONTEXTMENU: KoffiType
  WNDCLASSEXW: KoffiType
}

const structCache = new WeakMap<Koffi, ShellMenuStructs>()

/** Prefix of the koffi type names declared here. */
const TYPE_PREFIX = 'TaskyardShellMenu_'

/**
 * A named koffi type, declared once per process. Names, not anonymous types: koffi keeps pointer
 * types in a process-wide registry by name, and anonymous names (`<anonymous_N>`) can repeat, so
 * `koffi.pointer(anonymousStruct)` may return a stale pointer type to something else (seen in the
 * spike: a function-pointer type). The registry outlives a re-imported module, so an existing
 * name is looked up instead of redeclared.
 */
export function namedType(
  koffi: Koffi,
  name: string,
  declare: (name: string) => KoffiType
): KoffiType {
  const full = `${TYPE_PREFIX}${name}`
  try {
    return koffi.type(full) as KoffiType
  } catch {
    return declare(full)
  }
}

/** The x64 structs, as named koffi types. */
export function shellMenuStructs(koffi: Koffi): ShellMenuStructs {
  const cached = structCache.get(koffi)
  if (cached) return cached
  const struct = (name: string, def: Record<string, unknown>): KoffiType =>
    namedType(koffi, name, (full) => koffi.struct(full, def as never))
  const POINT = struct('POINT', { x: 'long', y: 'long' })
  const menuItemInfo = (name: string, dwTypeData: string): KoffiType =>
    struct(name, {
      cbSize: 'uint32_t',
      fMask: 'uint32_t',
      fType: 'uint32_t',
      fState: 'uint32_t',
      wID: 'uint32_t',
      hSubMenu: 'void *',
      hbmpChecked: 'void *',
      hbmpUnchecked: 'void *',
      dwItemData: 'uintptr_t',
      dwTypeData,
      cch: 'uint32_t',
      hbmpItem: 'void *'
    })
  const invokeInfo = (name: string, verb: string, verbW: string): KoffiType =>
    struct(name, {
      cbSize: 'uint32_t',
      fMask: 'uint32_t',
      hwnd: 'void *',
      lpVerb: verb,
      lpParameters: 'void *',
      lpDirectory: 'void *',
      nShow: 'int',
      dwHotKey: 'uint32_t',
      hIcon: 'void *',
      lpTitle: 'void *',
      lpVerbW: verbW,
      lpParametersW: 'void *',
      lpDirectoryW: 'void *',
      lpTitleW: 'void *',
      ptInvoke: POINT
    })
  const structs: ShellMenuStructs = {
    POINT,
    MENUITEMINFOW: menuItemInfo('MENUITEMINFOW', 'void *'),
    MENUITEMINFOW_TEXT: menuItemInfo('MENUITEMINFOW_TEXT', 'str16'),
    CMINVOKECOMMANDINFOEX_ID: invokeInfo('CMINVOKECOMMANDINFOEX_ID', 'uintptr_t', 'uintptr_t'),
    CMINVOKECOMMANDINFOEX_VERB: invokeInfo('CMINVOKECOMMANDINFOEX_VERB', 'str', 'str16'),
    DEFCONTEXTMENU: struct('DEFCONTEXTMENU', {
      hwnd: 'void *',
      pcmcb: 'void *',
      pidlFolder: 'void *',
      psf: 'void *',
      cidl: 'uint32_t',
      apidl: 'void *',
      punkAssociationInfo: 'void *',
      cKeys: 'uint32_t',
      aKeys: 'void *'
    }),
    WNDCLASSEXW: struct('WNDCLASSEXW', {
      cbSize: 'uint32_t',
      style: 'uint32_t',
      lpfnWndProc: 'void *',
      cbClsExtra: 'int',
      cbWndExtra: 'int',
      hInstance: 'void *',
      hIcon: 'void *',
      hCursor: 'void *',
      hbrBackground: 'void *',
      lpszMenuName: 'void *',
      lpszClassName: 'str16',
      hIconSm: 'void *'
    })
  }
  structCache.set(koffi, structs)
  return structs
}

/** The loaded DLL functions, COM prototypes and IIDs the shell-menu api calls. */
export type ShellMenuNative = ReturnType<typeof loadShellMenuNative>

/** Loads ole32/shell32/user32/kernel32/advapi32 and declares what the shell-menu api calls. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function loadShellMenuNative(koffi: Koffi) {
  const structs = shellMenuStructs(koffi)
  const ole32 = koffi.load('ole32.dll')
  const shell32 = koffi.load('shell32.dll')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')

  const CoTaskMemFree = ole32.func('void __stdcall CoTaskMemFree(void *pointer)')
  const OleInitialize = ole32.func('long __stdcall OleInitialize(void *reserved)')
  const OleFlushClipboard = ole32.func('long __stdcall OleFlushClipboard()')
  const OleGetClipboard = ole32.func('long __stdcall OleGetClipboard(_Out_ void **dataObject)')
  const CoGetApartmentType = ole32.func(
    'long __stdcall CoGetApartmentType(_Out_ int *type, _Out_ int *qualifier)'
  )
  const SHGetDesktopFolder = shell32.func('long __stdcall SHGetDesktopFolder(_Out_ void **folder)')
  const SHParseDisplayName = shell32.func(
    'long __stdcall SHParseDisplayName(str16 name, void *bindContext, _Out_ void **pidl, uint32_t sfgaoIn, _Out_ uint32_t *sfgaoOut)'
  )
  const SHBindToParent = shell32.func(
    'long __stdcall SHBindToParent(void *pidl, void *riid, _Out_ void **folder, _Out_ void **last)'
  )
  const SHCreateDefaultContextMenu = shell32.func(
    '__stdcall',
    'SHCreateDefaultContextMenu',
    'long',
    [koffi.pointer(structs.DEFCONTEXTMENU), 'void *', koffi.out(koffi.pointer('void *'))]
  )
  const RegOpenKeyExW = advapi32.func(
    'long __stdcall RegOpenKeyExW(intptr_t hkey, str16 subKey, uint32_t options, uint32_t sam, _Out_ intptr_t *result)'
  )
  const RegCloseKey = advapi32.func('long __stdcall RegCloseKey(intptr_t hkey)')
  const CreatePopupMenu = user32.func('void * __stdcall CreatePopupMenu()')
  const DestroyMenu = user32.func('int __stdcall DestroyMenu(void *menu)')
  const EnableMenuItem = user32.func(
    'int __stdcall EnableMenuItem(void *menu, uint32_t item, uint32_t flags)'
  )
  const DeleteMenu = user32.func(
    'int __stdcall DeleteMenu(void *menu, uint32_t position, uint32_t flags)'
  )
  const GetMenuItemCount = user32.func('int __stdcall GetMenuItemCount(void *menu)')
  const GetMenuItemInfoW = user32.func('__stdcall', 'GetMenuItemInfoW', 'int', [
    'void *',
    'uint32_t',
    'int',
    koffi.inout(koffi.pointer(structs.MENUITEMINFOW))
  ])
  const InsertMenuItemW = user32.func('__stdcall', 'InsertMenuItemW', 'int', [
    'void *',
    'uint32_t',
    'int',
    koffi.pointer(structs.MENUITEMINFOW_TEXT)
  ])
  const TrackPopupMenuEx = user32.func(
    'int __stdcall TrackPopupMenuEx(void *menu, uint32_t flags, int x, int y, void *hwnd, void *params)'
  )
  const SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(void *hwnd)')
  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()')
  const PostMessageW = user32.func(
    'int __stdcall PostMessageW(void *hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)'
  )
  const DefWindowProcW = user32.func(
    'intptr_t __stdcall DefWindowProcW(void *hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam)'
  )
  const CreateWindowExW = user32.func(
    'void * __stdcall CreateWindowExW(uint32_t exStyle, str16 className, str16 title, uint32_t style, int x, int y, int width, int height, void *parent, void *menu, void *instance, void *param)'
  )
  const DestroyWindow = user32.func('int __stdcall DestroyWindow(void *hwnd)')
  const RegisterClassExW = user32.func('__stdcall', 'RegisterClassExW', 'uint16_t', [
    koffi.pointer(structs.WNDCLASSEXW)
  ])
  const UnregisterClassW = user32.func(
    'int __stdcall UnregisterClassW(str16 className, void *instance)'
  )
  // MSG is filled in place in a 48-byte buffer (never decoded: it only goes back to Windows).
  const PeekMessageW = user32.func(
    'int __stdcall PeekMessageW(void *msg, void *hwnd, uint32_t filterMin, uint32_t filterMax, uint32_t remove)'
  )
  const TranslateMessage = user32.func('int __stdcall TranslateMessage(void *msg)')
  const DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(void *msg)')
  const GetKeyState = user32.func('int16_t __stdcall GetKeyState(int vk)')
  const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(void *name)')

  const proto = {
    bindToObject: koffi.proto('__stdcall', null, 'long', [
      'void *',
      'void *',
      'void *',
      'void *',
      koffi.out(koffi.pointer('void *'))
    ]),
    createViewObject: koffi.proto('__stdcall', null, 'long', [
      'void *',
      'void *',
      'void *',
      koffi.out(koffi.pointer('void *'))
    ]),
    getUIObjectOf: koffi.proto('__stdcall', null, 'long', [
      'void *',
      'void *',
      'uint32_t',
      'void *',
      'void *',
      'void *',
      koffi.out(koffi.pointer('void *'))
    ]),
    getItemObject: koffi.proto('__stdcall', null, 'long', [
      'void *',
      'uint32_t',
      'void *',
      koffi.out(koffi.pointer('void *'))
    ]),
    queryContextMenu: koffi.proto('__stdcall', null, 'long', [
      'void *',
      'void *',
      'uint32_t',
      'uint32_t',
      'uint32_t',
      'uint32_t'
    ]),
    invokeById: koffi.proto('__stdcall', null, 'long', [
      'void *',
      koffi.pointer(structs.CMINVOKECOMMANDINFOEX_ID)
    ]),
    invokeByVerb: koffi.proto('__stdcall', null, 'long', [
      'void *',
      koffi.pointer(structs.CMINVOKECOMMANDINFOEX_VERB)
    ]),
    getCommandString: koffi.proto('__stdcall', null, 'long', [
      'void *',
      'uintptr_t',
      'uint32_t',
      'void *',
      'void *',
      'uint32_t'
    ]),
    handleMenuMsg: koffi.proto('__stdcall', null, 'long', [
      'void *',
      'uint32_t',
      'uintptr_t',
      'intptr_t'
    ]),
    handleMenuMsg2: koffi.proto('__stdcall', null, 'long', [
      'void *',
      'uint32_t',
      'uintptr_t',
      'intptr_t',
      koffi.out(koffi.pointer('intptr_t'))
    ]),
    // IDropTarget::DragEnter(IDataObject *, DWORD grfKeyState, POINTL pt, DWORD *pdwEffect).
    dragEnter: koffi.proto('__stdcall', null, 'long', [
      'void *',
      'void *',
      'uint32_t',
      structs.POINT,
      koffi.inout(koffi.pointer('uint32_t'))
    ]),
    dragLeave: koffi.proto('__stdcall', null, 'long', ['void *'])
  }

  const IIDS = {
    shellFolder: parseGuid(IID_ISHELLFOLDER),
    shellView: parseGuid(IID_ISHELLVIEW),
    contextMenu: parseGuid(IID_ICONTEXTMENU),
    dropTarget: parseGuid(IID_IDROPTARGET)
  }

  return {
    structs,
    CoTaskMemFree,
    OleInitialize,
    OleFlushClipboard,
    OleGetClipboard,
    CoGetApartmentType,
    EnableMenuItem,
    SHGetDesktopFolder,
    SHParseDisplayName,
    SHBindToParent,
    SHCreateDefaultContextMenu,
    RegOpenKeyExW,
    RegCloseKey,
    CreatePopupMenu,
    DestroyMenu,
    DeleteMenu,
    GetMenuItemCount,
    GetMenuItemInfoW,
    InsertMenuItemW,
    TrackPopupMenuEx,
    SetForegroundWindow,
    GetForegroundWindow,
    PostMessageW,
    DefWindowProcW,
    CreateWindowExW,
    DestroyWindow,
    RegisterClassExW,
    UnregisterClassW,
    PeekMessageW,
    TranslateMessage,
    DispatchMessageW,
    GetKeyState,
    GetModuleHandleW,
    proto,
    IIDS
  }
}
