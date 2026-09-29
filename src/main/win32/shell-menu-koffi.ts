import type { Koffi } from './bindings'
import {
  checkHr,
  ComError,
  createComRuntime,
  initOleApartment,
  loadOle32,
  type ComRuntime
} from './com'
import { SHELL_MENU_OWNER_CLASS } from './constants'
import {
  DEFAULT_BACKGROUND_SOURCE,
  menuPaths,
  queryFlags,
  separatorsToRemove,
  SHELL_COMMAND_FIRST,
  SHELL_COMMAND_LAST,
  splitMenuText,
  submenuNamedBy,
  verbCommands,
  type BackgroundSource,
  type PlacedTaskyardItem,
  type ScreenPoint,
  type ShellMenuApi,
  type ShellMenuItem,
  type ShellMenuTarget,
  type ShowMenuRequest
} from './shell-menu-api'
import {
  FOREGROUND_REFUSED,
  invokeOutcome,
  invokesByVerb,
  matchesSubmenu,
  placeTaskyardMenus,
  resolveTaskyardItems,
  resolveShown,
  retireFocusTarget,
  returnsFocus,
  runInvoke,
  type PlacedReplacement
} from './shell-menu-shape'
import {
  BACKGROUND_KEYS,
  CMIC_MASK_CONTROL_DOWN,
  CMIC_MASK_PTINVOKE,
  CMIC_MASK_SHIFT_DOWN,
  CMIC_MASK_UNICODE,
  CONTEXT_MENU,
  DROP_TARGET,
  DROPEFFECT_COPY,
  DROPEFFECT_LINK,
  DROPEFFECT_MOVE,
  MF_BYCOMMAND,
  MF_ENABLED,
  MF_GRAYED,
  MFT_RADIOCHECK,
  GCS_VERBA,
  GCS_VERBW,
  HKEY_CLASSES_ROOT,
  IID_ICONTEXTMENU2,
  IID_ICONTEXTMENU3,
  KEY_READ,
  MENU_MESSAGES,
  MF_BYPOSITION,
  MFS_CHECKED,
  MFS_DISABLED,
  MFT_SEPARATOR,
  MFT_STRING,
  MIIM_FTYPE,
  MIIM_ID,
  MIIM_STATE,
  MIIM_STRING,
  MIIM_SUBMENU,
  PM_REMOVE,
  SHELL_FOLDER,
  SHELL_VIEW,
  SVGIO_BACKGROUND,
  SW_SHOWNORMAL,
  TPM_RETURNCMD,
  TPM_RIGHTBUTTON,
  VERB_CHARS,
  VK_CONTROL,
  VK_SHIFT,
  WM_INITMENUPOPUP,
  WM_NULL,
  WS_EX_TOOLWINDOW,
  WS_POPUP,
  loadShellMenuNative,
  namedType
} from './shell-menu-native'

/**
 * `ShellMenuApi` over shell32/user32/ole32 through koffi. Runs in the shell-menu helper process
 * (never in Taskyard's main process). Every operation builds its IContextMenu from scratch in a
 * `Scope` that releases each COM object, frees each PIDL, closes each key and destroys the menu
 * on every path. Menus are owned by a hidden top-level window created per operation; its WNDPROC
 * forwards WM_INITMENUPOPUP / WM_DRAWITEM / WM_MEASUREITEM / WM_MENUCHAR to IContextMenu3 (or 2)
 * so New ▸ and Send to ▸ fill in and owner-drawn items paint. COM layout per the Windows SDK
 * (ShObjIdl_core.h, WinUser.h), verified in shell-menu-koffi.win32.test.ts.
 */

interface MenuItemInfo {
  cbSize: number
  fMask: number
  fType: number
  fState: number
  wID: number
  hSubMenu: bigint | null
  hbmpChecked: null
  hbmpUnchecked: null
  dwItemData: number
  dwTypeData: Buffer | string | null
  cch: number
  hbmpItem: null
}

/** Cleanups run in reverse order, each guarded, so one failure never skips the rest. */
class Scope {
  private readonly cleanups: (() => void)[] = []
  constructor(private readonly onError: (error: unknown) => void) {}
  add(cleanup: () => void): void {
    this.cleanups.push(cleanup)
  }
  close(): void {
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        cleanup()
      } catch (error) {
        this.onError(error)
      }
    }
  }
}

/** A built menu: the handler, its optional IContextMenu2/3 and the populated HMENU. */
interface BuiltMenu {
  cm: bigint
  cm2: bigint | null
  cm3: bigint | null
  menu: bigint
  owner: bigint
  /** Background menus: the folder whose background it is (for the Paste state). */
  folder: bigint | null
}

/** Verbs that put files on the OLE clipboard: flushed at once, so they outlive the helper. */
const CLIPBOARD_VERBS = new Set(['copy', 'cut'])

const OWNER_CLASS = SHELL_MENU_OWNER_CLASS
/** Each api instance registers its own class (a class name is per process; see dispose). */
let ownerClasses = 0
/** An owner window outlives its operation this long (dialogs and async verbs may still use it). */
const OWNER_RETIRE_MS = 10_000
/** Messages dispatched per pump at most, so one pump never starves the JS thread. */
const PUMP_BATCH = 200

export interface KoffiShellMenuOptions {
  log?: { warn(message: string, ...details: unknown[]): void }
  /** Called each time the clipboard / drop target is asked about Paste (tests count it). */
  onPasteProbe?: () => void
}

/** The shell's context menus through koffi. Call from one thread only (the helper's JS thread). */
export function createKoffiShellMenuApi(
  koffi: Koffi,
  options: KoffiShellMenuOptions = {}
): ShellMenuApi {
  const warn = (message: string, ...details: unknown[]): void =>
    options.log?.warn(message, ...details)
  const native = loadShellMenuNative(koffi)
  // OLE, not just COM: Copy, Cut and Paste go through the OLE clipboard. Throws unless the
  // thread ends up a single-threaded apartment (the helper then reports `fatal`).
  initOleApartment(native)
  const com: ComRuntime = createComRuntime(koffi, loadOle32(koffi))
  com.init()
  const {
    structs,
    CoTaskMemFree,
    OleFlushClipboard,
    OleGetClipboard,
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
  } = native

  // --- The owner window class, its WNDPROC and the menu being tracked ---------------------------

  /** The menu whose handler gets the owner window's menu messages while it is tracked. */
  let tracking: BuiltMenu | null = null
  /** Hands a menu message to the handler (IContextMenu3, else 2); null when it declined. */
  const forwardMenuMessage = (
    target: BuiltMenu,
    message: number,
    wParam: bigint | number,
    lParam: bigint | number
  ): bigint | number | null => {
    if (target.cm3 !== null) {
      const result: [bigint | number] = [0]
      const hr = com.call(
        target.cm3,
        CONTEXT_MENU.HandleMenuMsg2,
        proto.handleMenuMsg2,
        message,
        wParam,
        lParam,
        result
      )
      return hr >= 0 ? result[0] : null
    }
    if (target.cm2 !== null) {
      const hr = com.call(
        target.cm2,
        CONTEXT_MENU.HandleMenuMsg,
        proto.handleMenuMsg,
        message,
        wParam,
        lParam
      )
      return hr >= 0 ? 0 : null
    }
    return null
  }

  const wndProcType = koffi.pointer(
    namedType(koffi, 'WNDPROC', (name) =>
      koffi.proto('__stdcall', name, 'intptr_t', ['void *', 'uint32_t', 'uintptr_t', 'intptr_t'])
    )
  )
  const wndProc = koffi.register(
    (hwnd: bigint, message: number, wParam: bigint | number, lParam: bigint | number) => {
      if (tracking !== null && MENU_MESSAGES.has(message)) {
        try {
          const handled = forwardMenuMessage(tracking, message, wParam, lParam)
          if (handled !== null) return handled
        } catch (error) {
          warn('shell-menu: a menu message handler threw', error)
        }
      }
      return DefWindowProcW(hwnd, message, wParam, lParam)
    },
    wndProcType
  )
  const instance = GetModuleHandleW(null) as bigint
  const ownerClass = `${OWNER_CLASS}.${process.pid}.${Date.now().toString(36)}.${++ownerClasses}`
  const atom = RegisterClassExW({
    cbSize: koffi.sizeof(structs.WNDCLASSEXW),
    style: 0,
    lpfnWndProc: wndProc,
    cbClsExtra: 0,
    cbWndExtra: 0,
    hInstance: instance,
    hIcon: null,
    hCursor: null,
    hbrBackground: null,
    lpszMenuName: null,
    lpszClassName: ownerClass,
    hIconSm: null
  })
  if (!atom) {
    koffi.unregister(wndProc)
    throw new Error('RegisterClassExW failed for the shell-menu owner window')
  }

  /**
   * Owner windows kept alive after their operation, with the time they may be destroyed and the
   * Taskyard window a shown menu came from (`returnFocusTo`).
   */
  const retiring: { hwnd: bigint; at: number; returnFocusTo: bigint | null }[] = []
  /** Show requests: the Taskyard window to return to, keyed by their owner window. */
  const returnTargets = new Map<bigint, bigint>()
  const destroyRetired = (all: boolean): void => {
    const now = Date.now()
    for (let index = retiring.length - 1; index >= 0; index--) {
      const entry = retiring[index]
      if (!all && entry.at > now) continue
      // Still the foreground window: nothing of Windows' took it; Taskyard gets the keyboard.
      const target = retireFocusTarget({
        owner: entry.hwnd,
        foreground: GetForegroundWindow() as bigint | null,
        returnFocusTo: entry.returnFocusTo
      })
      if (target !== null) SetForegroundWindow(target)
      DestroyWindow(entry.hwnd)
      retiring.splice(index, 1)
    }
  }

  /** A hidden, never-shown top-level window that owns one operation's menu and dialogs. */
  const createOwner = (scope: Scope): bigint => {
    const hwnd = CreateWindowExW(
      WS_EX_TOOLWINDOW,
      ownerClass,
      'Taskyard shell menu',
      WS_POPUP,
      0,
      0,
      0,
      0,
      null,
      null,
      instance,
      null
    ) as bigint | null
    if (!hwnd) throw new Error('CreateWindowExW failed for the shell-menu owner window')
    scope.add(() => {
      retiring.push({
        hwnd,
        at: Date.now() + OWNER_RETIRE_MS,
        returnFocusTo: returnTargets.get(hwnd) ?? null
      })
      returnTargets.delete(hwnd)
    })
    return hwnd
  }

  // --- Building IContextMenus ---------------------------------------------------------------------

  const release = (scope: Scope, self: bigint): bigint => {
    scope.add(() => com.release(self))
    return self
  }

  const desktopFolder = (scope: Scope): bigint => {
    const out: [bigint | null] = [null]
    checkHr(SHGetDesktopFolder(out) as number, 'SHGetDesktopFolder')
    if (!out[0]) throw new ComError('SHGetDesktopFolder returned no folder', 0)
    return release(scope, out[0])
  }

  const parsePath = (scope: Scope, path: string): bigint => {
    const out: [bigint | null] = [null]
    const attributes: [number] = [0]
    checkHr(SHParseDisplayName(path, null, out, 0, attributes) as number, 'SHParseDisplayName')
    if (!out[0]) throw new ComError('SHParseDisplayName returned no item', 0)
    const pidl = out[0]
    scope.add(() => CoTaskMemFree(pidl))
    return pidl
  }

  const folderAt = (scope: Scope, path: string): { folder: bigint; pidl: bigint } => {
    const desktop = desktopFolder(scope)
    const pidl = parsePath(scope, path)
    const out: [bigint | null] = [null]
    checkHr(
      com.call(
        desktop,
        SHELL_FOLDER.BindToObject,
        proto.bindToObject,
        pidl,
        null,
        IIDS.shellFolder,
        out
      ),
      'IShellFolder::BindToObject'
    )
    if (!out[0]) throw new ComError('BindToObject returned no folder', 0)
    return { folder: release(scope, out[0]), pidl }
  }

  const openKeys = (scope: Scope, names: readonly string[]): Buffer => {
    const keys = Buffer.alloc(8 * names.length)
    names.forEach((name, index) => {
      const out: [number | bigint] = [0]
      const status = RegOpenKeyExW(HKEY_CLASSES_ROOT, name, 0, KEY_READ, out) as number
      if (status !== 0) throw new Error(`RegOpenKeyExW(HKCR\\${name}) failed: ${status}`)
      const key = out[0]
      scope.add(() => RegCloseKey(key))
      keys.writeBigInt64LE(BigInt(key), index * 8)
    })
    return keys
  }

  const backgroundMenu = (
    scope: Scope,
    owner: bigint,
    folder: bigint,
    pidlFolder: bigint | null,
    desktop: boolean,
    source: BackgroundSource
  ): bigint => {
    const out: [bigint | null] = [null]
    switch (source) {
      case 'shell-view': {
        const view: [bigint | null] = [null]
        checkHr(
          com.call(
            folder,
            SHELL_FOLDER.CreateViewObject,
            proto.createViewObject,
            owner,
            IIDS.shellView,
            view
          ),
          'IShellFolder::CreateViewObject(IShellView)'
        )
        if (!view[0]) throw new ComError('CreateViewObject returned no view', 0)
        release(scope, view[0])
        checkHr(
          com.call(
            view[0],
            SHELL_VIEW.GetItemObject,
            proto.getItemObject,
            SVGIO_BACKGROUND,
            IIDS.contextMenu,
            out
          ),
          'IShellView::GetItemObject(SVGIO_BACKGROUND)'
        )
        break
      }
      case 'view-object':
        checkHr(
          com.call(
            folder,
            SHELL_FOLDER.CreateViewObject,
            proto.createViewObject,
            owner,
            IIDS.contextMenu,
            out
          ),
          'IShellFolder::CreateViewObject(IContextMenu)'
        )
        break
      case 'default-menu': {
        const names = desktop ? BACKGROUND_KEYS.desktop : BACKGROUND_KEYS.folder
        const keys = openKeys(scope, names)
        const info = {
          hwnd: owner,
          pcmcb: null,
          pidlFolder,
          psf: folder,
          cidl: 0,
          apidl: null,
          punkAssociationInfo: null,
          cKeys: names.length,
          aKeys: keys
        }
        checkHr(
          SHCreateDefaultContextMenu(info, IIDS.contextMenu, out) as number,
          'SHCreateDefaultContextMenu'
        )
        break
      }
    }
    if (!out[0]) throw new ComError('no background context menu', 0)
    return release(scope, out[0])
  }

  const itemsMenu = (scope: Scope, owner: bigint, paths: string[]): bigint => {
    const selected = menuPaths(paths)
    let parent: bigint | null = null
    const children = Buffer.alloc(8 * selected.length)
    selected.forEach((path, index) => {
      const pidl = parsePath(scope, path)
      const folder: [bigint | null] = [null]
      const last: [bigint | null] = [null]
      checkHr(SHBindToParent(pidl, IIDS.shellFolder, folder, last) as number, 'SHBindToParent')
      if (!folder[0] || !last[0]) throw new ComError('SHBindToParent returned nothing', 0)
      // `last` points into `pidl` (freed with it); only the first parent folder is kept.
      release(scope, folder[0])
      parent ??= folder[0]
      children.writeBigUInt64LE(last[0], index * 8)
    })
    const out: [bigint | null] = [null]
    checkHr(
      com.call(
        parent!,
        SHELL_FOLDER.GetUIObjectOf,
        proto.getUIObjectOf,
        owner,
        selected.length,
        children,
        IIDS.contextMenu,
        null,
        out
      ),
      'IShellFolder::GetUIObjectOf(IContextMenu)'
    )
    if (!out[0]) throw new ComError('GetUIObjectOf returned no menu', 0)
    return release(scope, out[0])
  }

  const contextMenuFor = (
    scope: Scope,
    owner: bigint,
    target: ShellMenuTarget,
    source: BackgroundSource
  ): { cm: bigint; folder: bigint | null } => {
    switch (target.kind) {
      case 'desktop-background': {
        const folder = desktopFolder(scope)
        return { cm: backgroundMenu(scope, owner, folder, null, true, source), folder }
      }
      case 'folder-background': {
        const { folder, pidl } = folderAt(scope, target.path)
        return { cm: backgroundMenu(scope, owner, folder, pidl, false, source), folder }
      }
      case 'items':
        return { cm: itemsMenu(scope, owner, target.paths), folder: null }
    }
  }

  /** Builds the handler and fills a new popup menu with QueryContextMenu. */
  const build = (
    scope: Scope,
    target: ShellMenuTarget,
    flags: number,
    source: BackgroundSource = DEFAULT_BACKGROUND_SOURCE
  ): BuiltMenu => {
    const owner = createOwner(scope)
    const { cm, folder } = contextMenuFor(scope, owner, target, source)
    const cm3 = com.queryInterface(cm, IID_ICONTEXTMENU3)
    if (cm3 !== null) release(scope, cm3)
    const cm2 = cm3 === null ? com.queryInterface(cm, IID_ICONTEXTMENU2) : null
    if (cm2 !== null) release(scope, cm2)
    const menu = CreatePopupMenu() as bigint | null
    if (!menu) throw new Error('CreatePopupMenu failed')
    scope.add(() => DestroyMenu(menu))
    checkHr(
      com.call(
        cm,
        CONTEXT_MENU.QueryContextMenu,
        proto.queryContextMenu,
        menu,
        0,
        SHELL_COMMAND_FIRST,
        SHELL_COMMAND_LAST,
        flags
      ),
      'IContextMenu::QueryContextMenu'
    )
    return { cm, cm2, cm3, menu, owner, folder }
  }

  /**
   * Whether the clipboard can be pasted into the background's folder: the folder's own
   * IDropTarget is asked (DragEnter, then DragLeave), as a paste really drops the clipboard's data
   * object there. The windowless shell view cannot tell by itself (its Paste is always grayed,
   * although invoking it works).
   */
  const canPaste = (scope: Scope, built: BuiltMenu): boolean => {
    options.onPasteProbe?.()
    const data: [bigint | null] = [null]
    if ((OleGetClipboard(data) as number) < 0 || !data[0]) return false
    release(scope, data[0])
    const target: [bigint | null] = [null]
    const hr = com.call(
      built.folder!,
      SHELL_FOLDER.CreateViewObject,
      proto.createViewObject,
      built.owner,
      IIDS.dropTarget,
      target
    )
    if (hr < 0 || !target[0]) return false
    release(scope, target[0])
    const effect: [number] = [DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK]
    const entered = com.call(
      target[0],
      DROP_TARGET.DragEnter,
      proto.dragEnter,
      data[0],
      0,
      { x: 0, y: 0 },
      effect
    )
    com.call(target[0], DROP_TARGET.DragLeave, proto.dragLeave)
    return entered >= 0 && effect[0] !== 0
  }

  /**
   * Background menus only, and only when asked: `show` right before displaying the menu (a user
   * right-click), or `enumerate` with `pasteState`. Never for preview or the warm-up: it reads the
   * live clipboard and wakes the folder's drop target (third-party extensions may react).
   */
  const setPasteState = (scope: Scope, built: BuiltMenu): void => {
    if (built.folder === null) return
    try {
      const commands = verbCommands(readMenu(built, false), ['paste', 'pastelink'])
      if (commands.length === 0) return
      const flags = MF_BYCOMMAND | (canPaste(scope, built) ? MF_ENABLED : MF_GRAYED)
      for (const command of commands) EnableMenuItem(built.menu, command, flags)
    } catch (error) {
      warn('shell-menu: could not work out whether Paste is possible', error)
    }
  }

  /** After Copy or Cut: render the data now, so it stays on the clipboard if the helper dies. */
  const flushClipboardAfter = (verb: string | null): void => {
    if (verb === null || !CLIPBOARD_VERBS.has(verb.toLowerCase())) return
    const hr = OleFlushClipboard() as number
    if (hr < 0) warn(`shell-menu: OleFlushClipboard failed (${hr})`)
  }

  // --- Reading and shaping menus ------------------------------------------------------------------

  const verbOf = (cm: bigint, offset: number): string | null => {
    const wide = Buffer.alloc(VERB_CHARS * 2)
    if (
      com.call(
        cm,
        CONTEXT_MENU.GetCommandString,
        proto.getCommandString,
        offset,
        GCS_VERBW,
        null,
        wide,
        VERB_CHARS
      ) >= 0
    ) {
      const verb = wide.toString('utf16le').split('\0')[0]
      if (verb) return verb
    }
    const narrow = Buffer.alloc(VERB_CHARS)
    if (
      com.call(
        cm,
        CONTEXT_MENU.GetCommandString,
        proto.getCommandString,
        offset,
        GCS_VERBA,
        null,
        narrow,
        VERB_CHARS
      ) >= 0
    ) {
      const verb = narrow.toString('latin1').split('\0')[0]
      if (verb) return verb
    }
    return null
  }

  const blankInfo = (fMask: number): MenuItemInfo => ({
    cbSize: koffi.sizeof(structs.MENUITEMINFOW),
    fMask,
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
  })

  interface Level {
    item: ShellMenuItem
    handle: bigint | null
    /** The label as stored (with its `&` mnemonic and accelerator). */
    text: string
  }

  /** Reads one menu level (and, recursively, its submenus); `init` forwards WM_INITMENUPOPUP. */
  const readLevel = (built: BuiltMenu, menu: bigint, init: boolean): Level[] => {
    const count = GetMenuItemCount(menu) as number
    const level: Level[] = []
    for (let position = 0; position < count; position++) {
      const info = blankInfo(MIIM_FTYPE | MIIM_ID | MIIM_STATE | MIIM_SUBMENU | MIIM_STRING)
      if (!GetMenuItemInfoW(menu, position, 1, info)) continue
      let text = ''
      if (info.cch > 0) {
        const buffer = Buffer.alloc((info.cch + 1) * 2)
        const textInfo = { ...blankInfo(MIIM_STRING), dwTypeData: buffer, cch: info.cch + 1 }
        if (GetMenuItemInfoW(menu, position, 1, textInfo))
          text = buffer.toString('utf16le').split('\0')[0]
      }
      const separator = (info.fType & MFT_SEPARATOR) !== 0
      const handle = info.hSubMenu ? info.hSubMenu : null
      // What the menu loop does before it opens a submenu: New ▸ and Send to ▸ fill in here.
      if (handle !== null && init) forwardMenuMessage(built, WM_INITMENUPOPUP, handle, position)
      const isShellCommand = info.wID >= SHELL_COMMAND_FIRST && info.wID <= SHELL_COMMAND_LAST
      const { label, accelerator } = splitMenuText(text)
      level.push({
        handle,
        text,
        item: {
          id: info.wID,
          label,
          accelerator,
          verb:
            !separator && handle === null && isShellCommand
              ? verbOf(built.cm, info.wID - SHELL_COMMAND_FIRST)
              : null,
          separator,
          disabled: (info.fState & MFS_DISABLED) !== 0,
          checked: (info.fState & MFS_CHECKED) !== 0,
          ...((info.fType & MFT_RADIOCHECK) !== 0 ? { radio: true } : {}),
          submenu:
            handle === null ? null : readLevel(built, handle, init).map((entry) => entry.item)
        }
      })
    }
    return level
  }

  const readMenu = (built: BuiltMenu, init: boolean): ShellMenuItem[] =>
    readLevel(built, built.menu, init).map((entry) => entry.item)

  /** `pruneMenu` applied to the real HMENU (see shell-menu-api.ts for the rules). */
  const prune = (
    built: BuiltMenu,
    menu: bigint,
    rules: { hideVerbs: string[]; hideSubmenus: string[] }
  ): void => {
    const level = readLevel(built, menu, false)
    for (let position = level.length - 1; position >= 0; position--) {
      const { item, handle } = level[position]
      const hideItem = handle === null && item.verb !== null && rules.hideVerbs.includes(item.verb)
      const hideSubmenu = handle !== null && submenuNamedBy(item, rules.hideSubmenus)
      if (hideItem || hideSubmenu) {
        DeleteMenu(menu, position, MF_BYPOSITION)
        continue
      }
      if (handle !== null) {
        const hadItems = (item.submenu ?? []).some((child) => !child.separator)
        prune(built, handle, rules)
        const left = readLevel(built, handle, false).some((entry) => !entry.item.separator)
        if (hadItems && !left) DeleteMenu(menu, position, MF_BYPOSITION)
      }
    }
    const kinds = readLevel(built, menu, false).map((entry): 'separator' | 'item' =>
      entry.item.separator ? 'separator' : 'item'
    )
    for (const position of separatorsToRemove(kinds).reverse())
      DeleteMenu(menu, position, MF_BYPOSITION)
  }

  /** Inserts Taskyard's items at `position` of `menu`; returns how many top-level entries. */
  const insertTaskyard = (menu: bigint, items: PlacedTaskyardItem[], position: number): number => {
    items.forEach((item, index) => {
      const info = { ...blankInfo(MIIM_FTYPE), dwTypeData: null as string | null }
      if (item.kind === 'separator') {
        info.fType = MFT_SEPARATOR
      } else if (item.kind === 'submenu') {
        const submenu = CreatePopupMenu() as bigint | null
        if (!submenu) throw new Error('CreatePopupMenu failed')
        insertTaskyard(submenu, item.items, 0)
        Object.assign(info, {
          fMask: MIIM_FTYPE | MIIM_STRING | MIIM_SUBMENU,
          fType: MFT_STRING,
          hSubMenu: submenu,
          dwTypeData: item.label
        })
      } else {
        Object.assign(info, {
          fMask: MIIM_FTYPE | MIIM_STRING | MIIM_ID | MIIM_STATE,
          fType: MFT_STRING | (item.radio ? MFT_RADIOCHECK : 0),
          wID: item.command,
          fState: (item.disabled ? MFS_DISABLED : 0) | (item.checked ? MFS_CHECKED : 0),
          dwTypeData: item.label
        })
      }
      if (!InsertMenuItemW(menu, position + index, 1, info))
        throw new Error('InsertMenuItemW failed')
    })
    return items.length
  }

  /** `replaceSubmenus` applied to the real HMENU: the shell submenu goes, Taskyard's takes its place. */
  const replaceOnMenu = (built: BuiltMenu, menu: bigint, pending: PlacedReplacement[]): void => {
    const level = readLevel(built, menu, false)
    level.forEach(({ item, handle, text }, position) => {
      if (handle === null || pending.length === 0) return
      const index = pending.findIndex((replacement) => matchesSubmenu(item, replacement.match))
      if (index < 0) {
        replaceOnMenu(built, handle, pending)
        return
      }
      const [replacement] = pending.splice(index, 1)
      // DeleteMenu destroys the shell's submenu; ours goes in at the same position.
      DeleteMenu(menu, position, MF_BYPOSITION)
      insertTaskyard(
        menu,
        [{ kind: 'submenu', label: replacement.label ?? text, items: replacement.items }],
        position
      )
    })
  }

  /**
   * Shapes a built menu for a request: Windows' labels for Taskyard items, replaced submenus,
   * hidden items, Taskyard's items on top. Returns the id map for Taskyard's commands.
   */
  const shapeBuilt = (built: BuiltMenu, request: ShowMenuRequest): Map<number, string> => {
    const shellTree = readMenu(built, false)
    const placed = placeTaskyardMenus(
      resolveTaskyardItems(request.taskyardItems, shellTree),
      request.replaceSubmenus.map((replacement) => ({
        ...replacement,
        items: resolveTaskyardItems(replacement.items, shellTree)
      }))
    )
    replaceOnMenu(built, built.menu, [...placed.replacements])
    prune(built, built.menu, request)
    const inserted = insertTaskyard(built.menu, placed.top, 0)
    if (inserted > 0 && (GetMenuItemCount(built.menu) as number) > inserted) {
      insertTaskyard(built.menu, [{ kind: 'separator' }], inserted)
    }
    return placed.idByCommand
  }

  const buildForShow = (scope: Scope, request: ShowMenuRequest): BuiltMenu =>
    build(
      scope,
      request.target,
      queryFlags({ extendedVerbs: request.extendedVerbs, items: request.target.kind === 'items' })
    )

  const invokeById = (built: BuiltMenu, offset: number, point: ScreenPoint): void => {
    const shift = (GetKeyState(VK_SHIFT) as number) < 0
    const control = (GetKeyState(VK_CONTROL) as number) < 0
    const info = {
      cbSize: koffi.sizeof(structs.CMINVOKECOMMANDINFOEX_ID),
      fMask:
        CMIC_MASK_UNICODE |
        CMIC_MASK_PTINVOKE |
        (shift ? CMIC_MASK_SHIFT_DOWN : 0) |
        (control ? CMIC_MASK_CONTROL_DOWN : 0),
      hwnd: built.owner,
      lpVerb: offset,
      lpParameters: null,
      lpDirectory: null,
      nShow: SW_SHOWNORMAL,
      dwHotKey: 0,
      hIcon: null,
      lpTitle: null,
      lpVerbW: offset,
      lpParametersW: null,
      lpDirectoryW: null,
      lpTitleW: null,
      ptInvoke: { x: point.x, y: point.y }
    }
    checkHr(
      com.call(built.cm, CONTEXT_MENU.InvokeCommand, proto.invokeById, info),
      'IContextMenu::InvokeCommand'
    )
  }

  /** InvokeCommand with a verb string (throws on failure; callers decide what a cancel means). */
  const invokeByVerb = (built: BuiltMenu, verb: string): void => {
    const info = {
      cbSize: koffi.sizeof(structs.CMINVOKECOMMANDINFOEX_VERB),
      fMask: CMIC_MASK_UNICODE,
      hwnd: built.owner,
      lpVerb: verb,
      lpParameters: null,
      lpDirectory: null,
      nShow: SW_SHOWNORMAL,
      dwHotKey: 0,
      hIcon: null,
      lpTitle: null,
      lpVerbW: verb,
      lpParametersW: null,
      lpDirectoryW: null,
      lpTitleW: null,
      ptInvoke: { x: 0, y: 0 }
    }
    checkHr(
      com.call(built.cm, CONTEXT_MENU.InvokeCommand, proto.invokeByVerb, info),
      `IContextMenu::InvokeCommand(${verb})`
    )
  }

  const operation = <T>(run: (scope: Scope) => T): T => {
    const scope = new Scope((error) => warn('shell-menu: cleanup failed', error))
    try {
      return run(scope)
    } finally {
      scope.close()
    }
  }

  let disposed = false

  return {
    enumerate(target, enumerateOptions) {
      return operation((scope) => {
        const built = build(
          scope,
          target,
          queryFlags({
            extendedVerbs: enumerateOptions.extendedVerbs,
            items: target.kind === 'items'
          }),
          enumerateOptions.source
        )
        if (enumerateOptions.pasteState) setPasteState(scope, built)
        return readMenu(built, true)
      })
    },

    preview(request) {
      return operation((scope) => {
        const built = buildForShow(scope, request)
        shapeBuilt(built, request)
        return readMenu(built, false)
      })
    },

    show(request, hooks) {
      return operation((scope) => {
        const built = buildForShow(scope, request)
        if (request.returnFocusTo !== undefined) {
          returnTargets.set(built.owner, BigInt(request.returnFocusTo))
        }
        const idByCommand = shapeBuilt(built, request)
        // Only now (the user right-clicked, the menu is about to show) is the clipboard read.
        setPasteState(scope, built)

        let command: number
        tracking = built
        try {
          // The foreground was granted by main (AllowSetForegroundWindow); without it the menu
          // would not close on an outside click (KB135788). Refused (the grant expired, another
          // app holds the foreground lock): no menu at all — an error before `showing`, so main
          // shows Taskyard's own menu instead of one the user could not dismiss.
          SetForegroundWindow(built.owner)
          if (GetForegroundWindow() !== built.owner) throw new Error(FOREGROUND_REFUSED)
          hooks.onShowing({ ownerHwnd: built.owner })
          command = TrackPopupMenuEx(
            built.menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            request.point.x,
            request.point.y,
            built.owner,
            null
          ) as number
          PostMessageW(built.owner, WM_NULL, 0, 0)
        } finally {
          tracking = null
        }

        const resolution = resolveShown(command, {
          tree: readMenu(built, false),
          idByCommand,
          interceptVerbs: request.interceptVerbs,
          interceptSubmenus: request.interceptSubmenus,
          background: request.target.kind !== 'items'
        })
        // A failure here is an outcome (the user already chose), a cancel counts as invoked.
        // Main hears that the menu closed and a command runs (it may block on a dialog).
        if (resolution.kind === 'invoke') hooks.onInvoking?.()
        const outcome =
          resolution.kind !== 'invoke'
            ? resolution
            : invokeOutcome(resolution, () => {
                const { verb } = resolution
                // DefView's own Paste does nothing by id on a windowless view; by verb it runs.
                if (verb !== null && invokesByVerb(verb, request.target.kind !== 'items')) {
                  invokeByVerb(built, verb)
                } else {
                  invokeById(built, resolution.offset, request.point)
                }
                flushClipboardAfter(verb)
              })
        // Phase 3: nothing of Windows' opened and the hidden owner window still has the
        // foreground: the keyboard goes back to Taskyard's window (inline rename, Ctrl+V…).
        if (
          request.returnFocusTo !== undefined &&
          returnsFocus(outcome) &&
          GetForegroundWindow() === built.owner
        ) {
          SetForegroundWindow(BigInt(request.returnFocusTo))
        }
        return outcome
      })
    },

    invokeVerb(target, verb) {
      operation((scope) => {
        const built = build(scope, target, queryFlags({ extendedVerbs: false, forInvoke: true }))
        runInvoke(() => invokeByVerb(built, verb))
        flushClipboardAfter(verb)
      })
    },

    pumpMessages() {
      const message = Buffer.alloc(48)
      for (
        let count = 0;
        count < PUMP_BATCH && PeekMessageW(message, null, 0, 0, PM_REMOVE);
        count++
      ) {
        TranslateMessage(message)
        DispatchMessageW(message)
      }
      destroyRetired(false)
    },

    dispose() {
      if (disposed) return
      disposed = true
      // What this process put on the clipboard stays there after it exits.
      OleFlushClipboard()
      destroyRetired(true)
      UnregisterClassW(ownerClass, instance)
      koffi.unregister(wndProc)
    }
  }
}
