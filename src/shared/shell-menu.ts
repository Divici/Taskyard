import type { IconSize } from './group-metrics'

// The native Windows right-click menus (native-menus plan, Phases 2–4): the Taskyard entries the
// shell-menu helper inserts into a real shell menu, and the Desktop background menu's policy —
// which Windows items Taskyard replaces, hides, intercepts or leaves to Windows. Types and pure
// rules only: main builds the helper request from them, the renderer routes the chosen ids.

// ---------------------------------------------------------------------------------------------
// Taskyard entries in a shell menu (shared with src/main/win32/shell-menu-api.ts)

/**
 * Where a Taskyard item may take Windows' own (localized) label from, in the menu being shown:
 * the item with `verb`, or the `index`-th non-separator item of the submenu holding `submenu`
 * (a verb; e.g. Sort by ▸'s columns have no verbs: `{ submenu: 'sortascending', index: 0 }` is
 * "Name"). The item's own `label` is used when Windows has no such item.
 */
export type LabelSource = { verb: string } | { submenu: string; index: number }

/** Taskyard's own entries in a native menu. Ids are stable strings; `&` marks an access key. */
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

// ---------------------------------------------------------------------------------------------
// The Desktop background menu (Phase 3)

/** Stable ids of Taskyard's items in the Desktop background menu (the renderer routes them). */
export const CANVAS_MENU_IDS = {
  // Taskyard ▸
  newGroup: 'taskyard.new-group',
  autoOrganize: 'taskyard.auto-organize',
  sortLoose: 'taskyard.sort-loose',
  toggleTools: 'taskyard.toggle-tools',
  refresh: 'taskyard.refresh',
  settings: 'taskyard.settings',
  quit: 'taskyard.quit',
  // View ▸ (replaced)
  iconLarge: 'view.icon-large',
  iconMedium: 'view.icon-medium',
  iconSmall: 'view.icon-small',
  gridSnap: 'view.grid-snap',
  showIcons: 'view.show-icons',
  // Sort by ▸ (replaced)
  sortName: 'sort.name',
  sortSize: 'sort.size',
  sortType: 'sort.type',
  sortDate: 'sort.date'
} as const

export type CanvasMenuId = (typeof CANVAS_MENU_IDS)[keyof typeof CANVAS_MENU_IDS]

/** How "Sort by ▸" orders the loose icons (Windows' four Desktop columns). */
export type LooseSortKey = 'name' | 'size' | 'type' | 'modified'

/** Which sort each Sort by ▸ id means. */
export const SORT_KEY_BY_ID: Readonly<Record<string, LooseSortKey>> = {
  [CANVAS_MENU_IDS.sortName]: 'name',
  [CANVAS_MENU_IDS.sortSize]: 'size',
  [CANVAS_MENU_IDS.sortType]: 'type',
  [CANVAS_MENU_IDS.sortDate]: 'modified'
}

/** Which icon size each View ▸ size id means. */
export const ICON_SIZE_BY_ID: Readonly<Record<string, IconSize>> = {
  [CANVAS_MENU_IDS.iconLarge]: 'large',
  [CANVAS_MENU_IDS.iconMedium]: 'medium',
  [CANVAS_MENU_IDS.iconSmall]: 'small'
}

/** What the menu's ticks and wording depend on (the right-clicked window's state). */
export interface CanvasMenuState {
  iconSize: IconSize
  gridSnap: boolean
  quickHidden: boolean
  /** The tools widget shows on this display ("Hide tools widget" rather than "Show"). */
  toolsShown: boolean
}

/** A show request's shaping fields (main adds the target, point, Shift and focus return). */
export interface BackgroundMenuPolicy {
  taskyardItems: TaskyardMenuItem[]
  replaceSubmenus: SubmenuReplacement[]
  hideVerbs: string[]
  hideSubmenus: string[]
  interceptVerbs: string[]
  interceptSubmenus: string[]
}

const item = (
  id: string,
  label: string,
  extra: Omit<Extract<TaskyardMenuItem, { kind: 'item' }>, 'kind' | 'id' | 'label'> = {}
): TaskyardMenuItem => ({ kind: 'item', id, label, ...extra })
const SEPARATOR: TaskyardMenuItem = { kind: 'separator' }

/** Sort by ▸'s columns in the shell view's order (Name, Size, Item type, Date modified). */
const SORT_COLUMNS: readonly [string, string][] = [
  [CANVAS_MENU_IDS.sortName, 'Name'],
  [CANVAS_MENU_IDS.sortSize, 'Size'],
  [CANVAS_MENU_IDS.sortType, 'Item type'],
  [CANVAS_MENU_IDS.sortDate, 'Date modified']
]

/**
 * The Desktop background menu as Taskyard shows it (Phase 2's recipe): the real shell-view menu
 * with a "Taskyard ▸" submenu on top, View ▸ and Sort by ▸ replaced in place by Taskyard's own
 * (their Windows commands would only change the invisible shell view: in the windowless view
 * Sort by and Auto arrange are disabled anyway), Group by ▸, the view modes and Redo hidden,
 * Refresh intercepted (→ rescan), and Undo and Paste intercepted: main runs them through Explorer's
 * own desktop view, because DefView's own commands do nothing without a view window (and a Paste
 * run in the helper hands the foreground to another app). Everything else — New ▸, Open in
 * Terminal, Display settings, Personalize, shell extensions — runs in Windows (the helper).
 */
export function backgroundMenuPolicy(state: CanvasMenuState): BackgroundMenuPolicy {
  const size = (id: string, label: string, verb: string, value: IconSize): TaskyardMenuItem =>
    item(id, label, { labelFrom: { verb }, radio: true, checked: state.iconSize === value })
  return {
    taskyardItems: [
      {
        kind: 'submenu',
        label: 'Tas&kyard',
        items: [
          item(CANVAS_MENU_IDS.newGroup, '&New group here'),
          item(CANVAS_MENU_IDS.autoOrganize, '&Auto-organize…'),
          item(CANVAS_MENU_IDS.sortLoose, '&Sort loose icons'),
          item(
            CANVAS_MENU_IDS.toggleTools,
            state.toolsShown ? 'Hide &tools widget' : 'Show &tools widget'
          ),
          SEPARATOR,
          item(CANVAS_MENU_IDS.refresh, '&Refresh desktop'),
          item(CANVAS_MENU_IDS.settings, 'Taskyard s&ettings'),
          SEPARATOR,
          item(CANVAS_MENU_IDS.quit, '&Quit Taskyard')
        ]
      }
    ],
    replaceSubmenus: [
      {
        match: { verb: 'viewlogicaliconslarge' },
        items: [
          size(CANVAS_MENU_IDS.iconLarge, 'Large icons', 'viewlogicaliconslarge', 'large'),
          size(CANVAS_MENU_IDS.iconMedium, 'Medium icons', 'viewlogicaliconsmedium', 'medium'),
          size(CANVAS_MENU_IDS.iconSmall, 'Small icons', 'viewlogicaliconssmall', 'small'),
          SEPARATOR,
          item(CANVAS_MENU_IDS.gridSnap, 'Align icons to grid', {
            labelFrom: { verb: 'arrangeautogrid' },
            checked: state.gridSnap
          }),
          SEPARATOR,
          item(CANVAS_MENU_IDS.showIcons, 'Show desktop &icons', { checked: !state.quickHidden })
        ]
      },
      {
        match: { verb: 'sortascending' },
        items: SORT_COLUMNS.map(([id, label], index) =>
          item(id, label, { labelFrom: { submenu: 'sortascending', index } })
        )
      }
    ],
    hideSubmenus: ['groupascending'],
    // Belt and braces: the replaced View ▸ held these; the helper also never invokes them.
    hideVerbs: [
      'viewcolsettings',
      'viewlogicallist',
      'viewlogicaldetails',
      'viewlogicaltiles',
      'viewlogicaliconsextralarge',
      'arrangeauto',
      // DefView's own Redo needs a view window, and no command reaches Explorer's (see Undo).
      'redo'
    ],
    // Refresh → rescan (renderer); Undo and Paste → main runs them through Explorer's own
    // desktop view (the windowless view ignores DefView's own commands).
    interceptVerbs: ['refresh', 'undo', 'paste'],
    interceptSubmenus: []
  }
}

export type MappingHandling = 'replaced' | 'intercepted' | 'hidden' | 'windows' | 'added'

/** One row of the Desktop background menu's mapping (the report and the user guide list it). */
export interface MappingRow {
  windows: string
  handling: MappingHandling
  taskyard: string
}

/** What becomes of each Windows item of the Desktop background menu. */
export const BACKGROUND_MENU_MAPPING: readonly MappingRow[] = [
  {
    windows: '(new) Taskyard ▸',
    handling: 'added',
    taskyard:
      'New group here, Auto-organize…, Sort loose icons, Show/Hide tools widget, Refresh desktop, Taskyard settings, Quit Taskyard'
  },
  {
    windows: 'View ▸ Large / Medium / Small icons',
    handling: 'replaced',
    taskyard: 'Taskyard icon size (Settings › Icon size)'
  },
  {
    windows: 'View ▸ Extra large icons, List, Details, Tiles',
    handling: 'hidden',
    taskyard: 'no Taskyard meaning (Taskyard has three icon sizes)'
  },
  {
    windows: 'View ▸ Auto arrange icons',
    handling: 'hidden',
    taskyard:
      'no Taskyard meaning (disabled in the windowless view; Sort loose icons arranges once)'
  },
  {
    windows: 'View ▸ Align icons to grid',
    handling: 'replaced',
    taskyard: 'Taskyard grid snap (Settings › Snap to grid)'
  },
  {
    windows: 'View ▸ Show desktop icons',
    handling: 'replaced',
    taskyard: 'quick-hide (unticked = icons and groups hidden)'
  },
  {
    windows: 'Sort by ▸ Name / Size / Item type / Date modified',
    handling: 'replaced',
    taskyard: 'sort this display’s loose icons by that key'
  },
  {
    windows: 'Sort by ▸ Ascending / Descending',
    handling: 'hidden',
    taskyard: 'no Taskyard meaning (disabled in the windowless view)'
  },
  {
    windows: 'Group by ▸',
    handling: 'hidden',
    taskyard: 'no Taskyard meaning (Explorer’s grouping of an invisible view)'
  },
  { windows: 'Refresh', handling: 'intercepted', taskyard: 'desktop:rescan (Refresh desktop)' },
  {
    windows: 'Paste',
    handling: 'intercepted',
    taskyard:
      'Explorer’s own desktop view pastes into the user’s Desktop folder (the windowless view ignores it); the item lands at the right-click point'
  },
  {
    windows: 'Paste shortcut',
    handling: 'windows',
    taskyard: 'not in this machine’s Desktop menu; if shown, the helper runs it by verb'
  },
  {
    windows: 'Undo …',
    handling: 'intercepted',
    taskyard:
      'Windows’ shared Undo, run by Explorer’s own desktop view (the windowless view ignores it)'
  },
  {
    windows: 'Redo …',
    handling: 'hidden',
    taskyard: 'no working command: DefView’s Redo needs a view window (Undo is kept)'
  },
  {
    windows: 'New ▸',
    handling: 'windows',
    taskyard:
      'creates in the user’s Desktop folder; placed at the right-click point, inline rename opens (Shortcut: its wizard names it)'
  },
  {
    windows: 'Open in Terminal, Open with Code/Cursor, Git, NVIDIA, other handlers',
    handling: 'windows',
    taskyard: 'run by Windows for the Desktop folder'
  },
  {
    windows: 'Display settings',
    handling: 'windows',
    taskyard: 'opens Windows Settings › Display'
  },
  {
    windows: 'Personalize',
    handling: 'windows',
    taskyard: 'opens Windows Settings › Personalization'
  }
]

/** A ShellNew item's verb: the new file's extension (`.txt`, `.docx`), exactly one dot. */
export function isShellNewVerb(verb: string | null): boolean {
  return verb !== null && /^\.[^\s.\\/:*?"<>|]+$/.test(verb)
}

/**
 * Whether an invoked background command makes a new Desktop item that belongs at the right-click
 * point, and whether it opens inline rename (Explorer's New folder / New text document do; the
 * Shortcut wizard names its own link, and pasted items keep their names). Null: nothing to place.
 */
export function newItemPlacement(verb: string | null): { rename: boolean } | null {
  if (verb === 'NewFolder' || isShellNewVerb(verb)) return { rename: true }
  if (verb === 'NewLink' || verb === 'paste' || verb === 'pastelink') return { rename: false }
  return null
}
