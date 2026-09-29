/**
 * Native Windows context menus (the shell's IContextMenu), behind one interface so every unit
 * test runs headless: `shell-menu-koffi.ts` builds real menus through shell32/user32, and
 * `shell-menu-fake.ts` answers from scripted menus. The api runs inside the shell-menu helper
 * process (src/main/shell-menu/helper.ts), never in Taskyard's main process: shell extensions
 * load into whatever process shows the menu, and TrackPopupMenuEx's modal loop blocks its thread.
 *
 * This module also holds the pure decisions both implementations share: which paths get one
 * menu, how Taskyard's own items are numbered, and what a chosen command means.
 */

/** A point in screen coordinates, physical pixels (what TrackPopupMenuEx takes). */
export interface ScreenPoint {
  x: number
  y: number
}

/**
 * What a menu is for. `desktop-background`: the Desktop namespace root (the user's Desktop merged
 * with the Public Desktop) — the menu Explorer shows on empty desktop. `folder-background`: empty
 * space in one folder. `items`: one or more files/folders (see `menuPaths` for the parent rule).
 */
export type ShellMenuTarget =
  | { kind: 'desktop-background' }
  | { kind: 'folder-background'; path: string }
  | { kind: 'items'; paths: string[] }

/**
 * Where a background menu comes from. Phase 2's spike compared all three on this machine:
 * - `shell-view` (chosen): the folder's IShellView (`CreateViewObject(IID_IShellView)`), asked for
 *   its background menu with `GetItemObject(SVGIO_BACKGROUND)` without ever creating the view
 *   window. This is DefView's own menu: View ▸, Sort by ▸, Group by ▸, Refresh, Paste, Undo, the
 *   Directory\Background and DesktopBackground handlers (Open in Terminal, New ▸, Display
 *   settings, Personalize) — what Explorer shows.
 * - `view-object`: `IShellFolder.CreateViewObject(IID_IContextMenu)` — handlers only (no View,
 *   Sort by, Refresh or Paste).
 * - `default-menu`: `SHCreateDefaultContextMenu` with the `DesktopBackground` /
 *   `Directory\Background` keys — handlers only, like `view-object`.
 */
export type BackgroundSource = 'shell-view' | 'view-object' | 'default-menu'
export const DEFAULT_BACKGROUND_SOURCE: BackgroundSource = 'shell-view'

/** One entry of a built menu, read back with GetMenuItemInfoW. */
export interface ShellMenuItem {
  /** wID: shell commands are SHELL_COMMAND_FIRST..LAST, Taskyard's ≥ TASKYARD_COMMAND_BASE. */
  id: number
  /** The text Windows shows, without `&` mnemonics or the accelerator. */
  label: string
  /** Text after a tab (e.g. `Ctrl+Z`), or null. */
  accelerator: string | null
  /** The canonical verb (`GetCommandString(GCS_VERBW)`), when the handler names one. */
  verb: string | null
  separator: boolean
  disabled: boolean
  checked: boolean
  /** Drawn with a radio bullet when checked (MFT_RADIOCHECK); only present when true. */
  radio?: boolean
  /** The items of a submenu (after WM_INITMENUPOPUP was forwarded), or null for a plain item. */
  submenu: ShellMenuItem[] | null
}

/**
 * Where a Taskyard item may take Windows' own (localized) label from, in the menu being shown:
 * the item with `verb`, or the `index`-th non-separator item of the submenu holding `submenu`
 * (a verb; e.g. Sort by ▸'s columns have no verbs: `{ submenu: 'sortascending', index: 0 }` is
 * "Name"). The item's own `label` is used when Windows has no such item.
 */
export type LabelSource = { verb: string } | { submenu: string; index: number }

/** Taskyard's own entries in a native menu. Ids are stable strings. */
export type TaskyardMenuItem =
  | {
      kind: 'item'
      id: string
      label: string
      disabled?: boolean
      checked?: boolean
      /** A radio bullet instead of a tick when checked (e.g. one of Large/Medium/Small icons). */
      radio?: boolean
      labelFrom?: LabelSource
    }
  | { kind: 'submenu'; label: string; items: TaskyardMenuItem[] }
  | { kind: 'separator' }

/** Which shell submenu a replacement takes over: by a verb it holds, or by its label. */
export type SubmenuMatch = { verb: string } | { label: string }

/**
 * Replaces a shell submenu in place (same position, Windows' own label unless `label` is given)
 * with Taskyard items — e.g. View ▸ and Sort by ▸ of the Desktop background, whose own commands
 * would only act on the invisible shell view.
 */
export interface SubmenuReplacement {
  match: SubmenuMatch
  label?: string
  items: TaskyardMenuItem[]
}

export interface ShowMenuRequest {
  target: ShellMenuTarget
  point: ScreenPoint
  /** Shift+right-click: `CMF_EXTENDEDVERBS` (e.g. Copy as path, Open PowerShell here). */
  extendedVerbs: boolean
  /** Inserted at the top, followed by a separator when there are any. */
  taskyardItems: TaskyardMenuItem[]
  /** Verbs Taskyard handles itself: chosen → returned as `intercepted`, never invoked. */
  interceptVerbs: string[]
  /**
   * Submenus Taskyard handles itself, named by any verb they contain (e.g. `sortascending` for
   * Sort by ▸, whose column items have no verb): every item in them is `intercepted`.
   */
  interceptSubmenus: string[]
  /** Verbs removed from the menu before it shows (loose separators are tidied up). */
  hideVerbs: string[]
  /** Submenus removed entirely, named by any verb they contain (e.g. `groupascending`). */
  hideSubmenus: string[]
  /** Shell submenus replaced by Taskyard items (applied before `hideVerbs`/`hideSubmenus`). */
  replaceSubmenus: SubmenuReplacement[]
}

export type ShowMenuOutcome =
  | { kind: 'dismissed' }
  | { kind: 'taskyard'; id: string }
  /** `path`: the labels of the submenus leading to the item (e.g. `['Sort by']`). */
  | { kind: 'intercepted'; verb: string | null; label: string; path: string[] }
  | { kind: 'invoked'; verb: string | null; label: string; path: string[] }
  /**
   * The user chose a shell item but running it failed (not a cancel: ERROR_CANCELLED counts as
   * invoked). The menu was shown and used, so callers must not fall back to another menu.
   */
  | { kind: 'invoke-failed'; verb: string | null; label: string; path: string[]; message: string }

export interface EnumerateOptions {
  extendedVerbs: boolean
  /** Background targets only; `DEFAULT_BACKGROUND_SOURCE` when omitted. */
  source?: BackgroundSource
  /**
   * Background targets only: work out Paste's state from the live clipboard (reads the OLE
   * clipboard and asks the folder's drop target whether it would accept it). Default off —
   * enumerate never touches the clipboard or a drop target unless asked. `show` always does it,
   * right before the menu is displayed (a user right-click).
   */
  pasteState?: boolean
}

export interface ShowHooks {
  /** Called right before the menu's modal loop starts, with the window that owns the menu. */
  onShowing(info: { ownerHwnd: bigint }): void
}

export interface ShellMenuApi {
  /**
   * Builds the menu (every submenu initialised) and reads its items. Shows and invokes nothing,
   * and leaves the clipboard and drop targets alone unless `options.pasteState` asks.
   */
  enumerate(target: ShellMenuTarget, options: EnumerateOptions): ShellMenuItem[]
  /**
   * Shows the menu at `request.point` and blocks until it closes; a chosen shell command that is
   * not intercepted is invoked before this returns. Background menus: right before showing,
   * Paste's state is worked out from the clipboard (the only call that does this by itself).
   */
  show(request: ShowMenuRequest, hooks: ShowHooks): ShowMenuOutcome
  /**
   * The menu exactly as `show` would present it (replacements, hidden items and Taskyard's items
   * applied), without showing it. For tests and diagnostics; never touches the clipboard (Paste
   * keeps the shell view's own state).
   */
  preview(request: ShowMenuRequest): ShellMenuItem[]
  /** Invokes `verb` for the target without showing a menu (a cancelled invoke is not an error). */
  invokeVerb(target: ShellMenuTarget, verb: string): void
  /**
   * Dispatches the window messages waiting for this thread. The helper's JS thread has no
   * message loop of its own (it runs libuv), so verbs that finish asynchronously and windows
   * shell extensions create on it only get their messages when the helper pumps.
   */
  pumpMessages(): void
  /** Flushes the OLE clipboard (a Copy outlives the helper) and releases the window class. */
  dispose(): void
}

// QueryContextMenu flags (ShObjIdl_core.h).
export const CMF_NORMAL = 0x0
export const CMF_CANRENAME = 0x10
export const CMF_ITEMMENU = 0x80
export const CMF_EXTENDEDVERBS = 0x100
export const CMF_OPTIMIZEFORINVOKE = 0x800

/** Shell handlers get ids SHELL_COMMAND_FIRST..LAST (idCmdFirst..idCmdLast of QueryContextMenu). */
export const SHELL_COMMAND_FIRST = 1
export const SHELL_COMMAND_LAST = 0x7fff
/** Taskyard's own items are numbered from here, above every shell id. */
export const TASKYARD_COMMAND_BASE = 0x8000
/** Menu ids are 16-bit in WM_COMMAND, so Taskyard's range ends at 0xFFFF. */
const TASKYARD_COMMAND_MAX = 0xffff

export function queryFlags(options: {
  extendedVerbs: boolean
  /** A menu for items rather than the background (DefView passes CMF_ITEMMENU then). */
  items?: boolean
  forInvoke?: boolean
}): number {
  if (options.forInvoke) return CMF_OPTIMIZEFORINVOKE
  return (
    CMF_NORMAL |
    CMF_CANRENAME |
    (options.items ? CMF_ITEMMENU : 0) |
    (options.extendedVerbs ? CMF_EXTENDEDVERBS : 0)
  )
}

/** NTFS-style comparison key of a path's parent folder. */
function parentKey(path: string): string {
  const normal = path.replace(/\//g, '\\').replace(/\\+$/, '')
  const cut = normal.lastIndexOf('\\')
  return (cut < 0 ? '' : normal.slice(0, cut)).toUpperCase()
}

/**
 * The paths that get one menu: all of them when they share a parent folder (one IShellFolder
 * answers GetUIObjectOf for all), otherwise the right-clicked (first) item alone — the plan's
 * shared-parent rule. Duplicates are dropped.
 */
export function menuPaths(paths: string[]): string[] {
  if (paths.length === 0) throw new Error('a file menu needs at least one path')
  const seen = new Set<string>()
  const unique = paths.filter((path) => {
    const key = path.replace(/\//g, '\\').toUpperCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const parent = parentKey(unique[0])
  return unique.every((path) => parentKey(path) === parent) ? unique : [unique[0]]
}

/** Menu text → what Windows shows: `&x` mnemonics removed (`&&` is a literal `&`), tab split. */
export function splitMenuText(text: string): { label: string; accelerator: string | null } {
  const tab = text.indexOf('\t')
  const main = tab < 0 ? text : text.slice(0, tab)
  const accelerator = tab < 0 ? null : text.slice(tab + 1)
  return { label: main.replace(/&(&?)/g, '$1'), accelerator: accelerator || null }
}

export type PlacedTaskyardItem =
  | {
      kind: 'item'
      command: number
      label: string
      disabled: boolean
      checked: boolean
      /** Only present when true. */
      radio?: boolean
    }
  | { kind: 'submenu'; label: string; items: PlacedTaskyardItem[] }
  | { kind: 'separator' }

/**
 * Numbers Taskyard's clickable items from TASKYARD_COMMAND_BASE in menu order and keeps the way
 * back from a number to the stable id. Duplicate ids are refused (a click could not be told
 * apart), as is running out of 16-bit ids.
 */
export function placeTaskyardItems(items: TaskyardMenuItem[]): {
  items: PlacedTaskyardItem[]
  idByCommand: Map<number, string>
} {
  const idByCommand = new Map<number, string>()
  const used = new Set<string>()
  let next = TASKYARD_COMMAND_BASE
  const place = (list: TaskyardMenuItem[]): PlacedTaskyardItem[] =>
    list.map((item): PlacedTaskyardItem => {
      if (item.kind === 'separator') return item
      if (item.kind === 'submenu')
        return { kind: 'submenu', label: item.label, items: place(item.items) }
      if (used.has(item.id)) throw new Error(`duplicate Taskyard menu id "${item.id}"`)
      if (next > TASKYARD_COMMAND_MAX) throw new Error('too many Taskyard menu items')
      used.add(item.id)
      const command = next++
      idByCommand.set(command, item.id)
      return {
        kind: 'item',
        command,
        label: item.label,
        disabled: item.disabled ?? false,
        checked: item.checked ?? false,
        ...(item.radio ? { radio: true } : {})
      }
    })
  return { items: place(items), idByCommand }
}

/**
 * Indexes of the separators to delete from one menu level so none is leading, trailing or
 * doubled (after hiding items, or where a handler left one).
 */
export function separatorsToRemove(kinds: ('separator' | 'item')[]): number[] {
  const remove: number[] = []
  let previousKept: 'separator' | 'item' | null = null
  kinds.forEach((kind, index) => {
    if (kind === 'separator' && previousKept !== 'item') {
      remove.push(index)
      return
    }
    previousKept = kind
  })
  // A trailing kept separator goes too.
  for (let index = kinds.length - 1; index >= 0; index--) {
    if (remove.includes(index)) continue
    if (kinds[index] === 'separator') remove.push(index)
    break
  }
  return remove.sort((a, b) => a - b)
}

/** True when `item` is a submenu holding (directly) an item with one of `verbs`. */
export function submenuNamedBy(item: ShellMenuItem, verbs: string[]): boolean {
  return (item.submenu ?? []).some((child) => child.verb !== null && verbs.includes(child.verb))
}

/**
 * The menu without hidden verbs and submenus: an item whose verb is in `hideVerbs` goes, a
 * submenu named by a verb in `hideSubmenus` goes whole, a submenu left empty goes, and loose
 * separators are tidied. The koffi implementation applies the same rules to the real HMENU.
 */
export function pruneMenu(
  tree: ShellMenuItem[],
  rules: { hideVerbs: string[]; hideSubmenus: string[] }
): ShellMenuItem[] {
  if (rules.hideVerbs.length === 0 && rules.hideSubmenus.length === 0) return tree
  const kept = tree.flatMap((item): ShellMenuItem[] => {
    if (item.submenu === null) {
      return item.verb !== null && rules.hideVerbs.includes(item.verb) ? [] : [item]
    }
    if (submenuNamedBy(item, rules.hideSubmenus)) return []
    const inner = pruneMenu(item.submenu, rules)
    const hadItems = item.submenu.some((child) => !child.separator)
    return hadItems && !inner.some((child) => !child.separator) ? [] : [{ ...item, submenu: inner }]
  })
  const drop = new Set(
    separatorsToRemove(kept.map((item) => (item.separator ? 'separator' : 'item')))
  )
  return kept.filter((_, index) => !drop.has(index))
}

/** The ids of every item, at any depth, whose verb is in `verbs`. */
export function verbCommands(tree: ShellMenuItem[], verbs: string[]): number[] {
  const wanted = new Set(verbs)
  return tree.flatMap((item) => [
    ...(item.verb !== null && wanted.has(item.verb) && item.submenu === null ? [item.id] : []),
    ...(item.submenu ? verbCommands(item.submenu, verbs) : [])
  ])
}

export type CommandResolution =
  | { kind: 'dismissed' }
  | { kind: 'taskyard'; id: string }
  | { kind: 'intercepted'; verb: string | null; label: string; path: string[] }
  /** `offset`: the id minus SHELL_COMMAND_FIRST, as InvokeCommand and GetCommandString take it. */
  | { kind: 'invoke'; offset: number; verb: string | null; label: string; path: string[] }

interface Located {
  item: ShellMenuItem
  path: string[]
  /** The verbs of the submenus the item sits in, innermost last. */
  ancestors: ShellMenuItem[]
}

function locate(tree: ShellMenuItem[], id: number, path: ShellMenuItem[] = []): Located | null {
  for (const item of tree) {
    if (item.submenu) {
      const found = locate(item.submenu, id, [...path, item])
      if (found) return found
    } else if (!item.separator && item.id === id) {
      return { item, path: path.map((parent) => parent.label), ancestors: path }
    }
  }
  return null
}

/**
 * Commands of the shell view's own state (View ▸ modes, Auto arrange / Align to grid, Sort by ▸,
 * Group by ▸, More…). On a background menu they would change an invisible view, so they are never
 * invoked there — chosen, they come back as `intercepted`, like the items of their submenus.
 */
export const VIEW_STATE_VERB = /^(viewlogical|viewcol|arrange|sort|group)/i

const isViewStateVerb = (verb: string | null): boolean =>
  verb !== null && VIEW_STATE_VERB.test(verb)

/** What the id TrackPopupMenuEx returned means (0 = the menu was dismissed). */
export function resolveCommand(
  command: number,
  context: {
    tree: ShellMenuItem[]
    idByCommand: Map<number, string>
    interceptVerbs: string[]
    interceptSubmenus: string[]
    /** Background menus: never invoke the invisible view's own commands (VIEW_STATE_VERB). */
    guardViewState?: boolean
  }
): CommandResolution {
  if (command <= 0) return { kind: 'dismissed' }
  if (command >= TASKYARD_COMMAND_BASE) {
    const id = context.idByCommand.get(command)
    return id === undefined ? { kind: 'dismissed' } : { kind: 'taskyard', id }
  }
  const found = locate(context.tree, command)
  const verb = found?.item.verb ?? null
  const label = found?.item.label ?? ''
  const path = found?.path ?? []
  const inInterceptedSubmenu =
    found?.ancestors.some((submenu) => submenuNamedBy(submenu, context.interceptSubmenus)) ?? false
  const viewState =
    (context.guardViewState ?? false) &&
    (isViewStateVerb(verb) ||
      (found?.ancestors.some((submenu) =>
        (submenu.submenu ?? []).some((sibling) => isViewStateVerb(sibling.verb))
      ) ??
        false))
  if (
    viewState ||
    inInterceptedSubmenu ||
    (verb !== null && context.interceptVerbs.includes(verb))
  ) {
    return { kind: 'intercepted', verb, label, path }
  }
  return { kind: 'invoke', offset: command - SHELL_COMMAND_FIRST, verb, label, path }
}
