import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_MENU_MAPPING,
  CANVAS_MENU_IDS,
  backgroundMenuPolicy,
  isShellNewVerb,
  newItemPlacement,
  type CanvasMenuState,
  type TaskyardMenuItem
} from './shell-menu'

const STATE: CanvasMenuState = {
  iconSize: 'medium',
  gridSnap: true,
  quickHidden: false,
  toolsShown: false
}

/** Every clickable item (depth-first) of a Taskyard item list. */
function clickable(items: TaskyardMenuItem[]): Extract<TaskyardMenuItem, { kind: 'item' }>[] {
  return items.flatMap((item) =>
    item.kind === 'item' ? [item] : item.kind === 'submenu' ? clickable(item.items) : []
  )
}

describe('backgroundMenuPolicy (the native Desktop background menu, Phase 3)', () => {
  it('puts one Taskyard ▸ submenu on top with the canvas actions, Quit last', () => {
    const policy = backgroundMenuPolicy(STATE)
    expect(policy.taskyardItems).toHaveLength(1)
    const [taskyard] = policy.taskyardItems
    expect(taskyard.kind).toBe('submenu')
    if (taskyard.kind !== 'submenu') return
    expect(taskyard.label.replace('&', '')).toBe('Taskyard')
    expect(taskyard.items.map((item) => (item.kind === 'item' ? item.id : item.kind))).toEqual([
      CANVAS_MENU_IDS.newGroup,
      CANVAS_MENU_IDS.autoOrganize,
      CANVAS_MENU_IDS.sortLoose,
      CANVAS_MENU_IDS.toggleTools,
      'separator',
      CANVAS_MENU_IDS.refresh,
      CANVAS_MENU_IDS.settings,
      'separator',
      CANVAS_MENU_IDS.quit
    ])
  })

  it('words the tools item by whether the widget shows on this display', () => {
    const label = (toolsShown: boolean): string | undefined =>
      clickable(backgroundMenuPolicy({ ...STATE, toolsShown }).taskyardItems)
        .find((item) => item.id === CANVAS_MENU_IDS.toggleTools)
        ?.label.replace('&', '')
    expect(label(false)).toBe('Show tools widget')
    expect(label(true)).toBe('Hide tools widget')
  })

  it('replaces View ▸ with Taskyard icon sizes (radio), grid snap and quick-hide', () => {
    const view = backgroundMenuPolicy({ ...STATE, iconSize: 'small', gridSnap: false })
      .replaceSubmenus[0]
    expect(view.match).toEqual({ verb: 'viewlogicaliconslarge' })
    const items = clickable(view.items)
    expect(items.map((item) => item.id)).toEqual([
      CANVAS_MENU_IDS.iconLarge,
      CANVAS_MENU_IDS.iconMedium,
      CANVAS_MENU_IDS.iconSmall,
      CANVAS_MENU_IDS.gridSnap,
      CANVAS_MENU_IDS.showIcons
    ])
    expect(items.filter((item) => item.radio).map((item) => item.id)).toEqual([
      CANVAS_MENU_IDS.iconLarge,
      CANVAS_MENU_IDS.iconMedium,
      CANVAS_MENU_IDS.iconSmall
    ])
    expect(items.filter((item) => item.checked).map((item) => item.id)).toEqual([
      CANVAS_MENU_IDS.iconSmall,
      CANVAS_MENU_IDS.showIcons
    ])
    // Windows' own (localized) labels where Windows has the item.
    expect(items.find((item) => item.id === CANVAS_MENU_IDS.iconLarge)?.labelFrom).toEqual({
      verb: 'viewlogicaliconslarge'
    })
    expect(items.find((item) => item.id === CANVAS_MENU_IDS.gridSnap)?.labelFrom).toEqual({
      verb: 'arrangeautogrid'
    })
  })

  it('ticks grid snap and unticks Show desktop icons while quick-hidden', () => {
    const items = clickable(
      backgroundMenuPolicy({ ...STATE, gridSnap: true, quickHidden: true }).replaceSubmenus[0].items
    )
    expect(items.find((item) => item.id === CANVAS_MENU_IDS.gridSnap)?.checked).toBe(true)
    expect(items.find((item) => item.id === CANVAS_MENU_IDS.showIcons)?.checked).toBe(false)
  })

  it('replaces Sort by ▸ with the four sort keys, labelled from Windows’ columns', () => {
    const sort = backgroundMenuPolicy(STATE).replaceSubmenus[1]
    expect(sort.match).toEqual({ verb: 'sortascending' })
    expect(clickable(sort.items).map((item) => [item.id, item.label, item.labelFrom])).toEqual([
      [CANVAS_MENU_IDS.sortName, 'Name', { submenu: 'sortascending', index: 0 }],
      [CANVAS_MENU_IDS.sortSize, 'Size', { submenu: 'sortascending', index: 1 }],
      [CANVAS_MENU_IDS.sortType, 'Item type', { submenu: 'sortascending', index: 2 }],
      [CANVAS_MENU_IDS.sortDate, 'Date modified', { submenu: 'sortascending', index: 3 }]
    ])
  })

  it('hides Group by ▸, the view modes and Redo; intercepts Refresh, Undo and Paste', () => {
    const policy = backgroundMenuPolicy(STATE)
    expect(policy.hideSubmenus).toEqual(['groupascending'])
    expect(policy.hideVerbs).toEqual(
      expect.arrayContaining([
        'viewcolsettings',
        'viewlogicallist',
        'viewlogicaldetails',
        'viewlogicaltiles',
        'viewlogicaliconsextralarge',
        'arrangeauto',
        // DefView's own Redo needs a view window; Taskyard has no way to run it (report).
        'redo'
      ])
    )
    expect(policy.hideVerbs).not.toContain('undo')
    expect(policy.hideVerbs).not.toContain('paste')
    // Undo and Paste run through Explorer's desktop view (the windowless view ignores them).
    expect(policy.interceptVerbs).toEqual(['refresh', 'undo', 'paste'])
    expect(policy.interceptSubmenus).toEqual([])
  })

  it('uses every id once (a click maps back to exactly one action)', () => {
    const policy = backgroundMenuPolicy(STATE)
    const ids = [
      ...clickable(policy.taskyardItems),
      ...policy.replaceSubmenus.flatMap((replacement) => clickable(replacement.items))
    ].map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(ids)).toEqual(new Set(Object.values(CANVAS_MENU_IDS)))
  })
})

describe('the mapping table', () => {
  it('names every Windows item Taskyard maps, replaces, hides or leaves to Windows', () => {
    const byWindows = new Map(BACKGROUND_MENU_MAPPING.map((row) => [row.windows, row]))
    expect(byWindows.get('View ▸ Large / Medium / Small icons')?.taskyard).toMatch(/icon size/i)
    expect(byWindows.get('Sort by ▸ Name / Size / Item type / Date modified')?.handling).toBe(
      'replaced'
    )
    expect(byWindows.get('Refresh')?.handling).toBe('intercepted')
    expect(byWindows.get('Group by ▸')?.handling).toBe('hidden')
    expect(byWindows.get('Paste')?.handling).toBe('intercepted')
    expect(byWindows.get('New ▸')?.handling).toBe('windows')
    expect(byWindows.get('Undo …')?.handling).toBe('intercepted')
    expect(byWindows.get('Redo …')?.handling).toBe('hidden')
  })
})

describe('newItemPlacement (New ▸ / Paste land at the right-click point)', () => {
  it('New ▸ Folder and ShellNew files open inline rename', () => {
    expect(newItemPlacement('NewFolder')).toEqual({ rename: true })
    expect(newItemPlacement('.txt')).toEqual({ rename: true })
    expect(newItemPlacement('.docx')).toEqual({ rename: true })
  })

  it('a new shortcut (its wizard names it) and pasted items are only placed', () => {
    expect(newItemPlacement('NewLink')).toEqual({ rename: false })
    expect(newItemPlacement('paste')).toEqual({ rename: false })
    expect(newItemPlacement('pastelink')).toEqual({ rename: false })
  })

  it('anything else creates nothing to place', () => {
    for (const verb of [null, 'Display', 'Personalize', 'undo', 'refresh', '.', 'a.txt', '.a b']) {
      expect(newItemPlacement(verb)).toBeNull()
    }
  })

  it('recognises ShellNew verbs as a single extension', () => {
    expect(isShellNewVerb('.accdb')).toBe(true)
    expect(isShellNewVerb('.tar.gz')).toBe(false)
    expect(isShellNewVerb('NewFolder')).toBe(false)
    expect(isShellNewVerb(null)).toBe(false)
  })
})
