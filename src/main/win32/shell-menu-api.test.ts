import { describe, expect, it } from 'vitest'
import {
  CMF_CANRENAME,
  CMF_EXTENDEDVERBS,
  CMF_ITEMMENU,
  CMF_NORMAL,
  CMF_OPTIMIZEFORINVOKE,
  menuPaths,
  placeTaskyardItems,
  pruneMenu,
  queryFlags,
  resolveCommand,
  separatorsToRemove,
  SHELL_COMMAND_FIRST,
  SHELL_COMMAND_LAST,
  splitMenuText,
  TASKYARD_COMMAND_BASE,
  verbCommands,
  type ShellMenuItem,
  type TaskyardMenuItem
} from './shell-menu-api'

function item(id: number, label: string, verb: string | null = null): ShellMenuItem {
  return {
    id,
    label,
    accelerator: null,
    verb,
    separator: false,
    disabled: false,
    checked: false,
    submenu: null
  }
}
const separator: ShellMenuItem = { ...item(0, ''), separator: true }
function submenu(label: string, items: ShellMenuItem[]): ShellMenuItem {
  return { ...item(0, label), submenu: items }
}

describe('command id ranges', () => {
  it('keeps shell commands below Taskyard commands, like the plan (shell 1..0x7FFF, Taskyard ≥ 0x8000)', () => {
    expect(SHELL_COMMAND_FIRST).toBe(1)
    expect(SHELL_COMMAND_LAST).toBe(0x7fff)
    expect(TASKYARD_COMMAND_BASE).toBe(0x8000)
  })
})

describe('menuPaths (the shared-parent rule)', () => {
  it('keeps every path when all share a parent folder (case-insensitive, like NTFS)', () => {
    expect(menuPaths(['C:\\Users\\a\\Desktop\\one.txt', 'c:\\users\\A\\desktop\\Two.lnk'])).toEqual(
      ['C:\\Users\\a\\Desktop\\one.txt', 'c:\\users\\A\\desktop\\Two.lnk']
    )
  })

  it('falls back to the right-clicked (first) item alone when the parents differ', () => {
    expect(
      menuPaths(['C:\\Users\\a\\Desktop\\one.txt', 'C:\\Users\\Public\\Desktop\\app.lnk'])
    ).toEqual(['C:\\Users\\a\\Desktop\\one.txt'])
  })

  it('drops duplicates and treats forward slashes like backslashes', () => {
    expect(menuPaths(['C:/tmp/a.txt', 'C:\\TMP\\A.TXT', 'C:\\tmp\\b.txt'])).toEqual([
      'C:/tmp/a.txt',
      'C:\\tmp\\b.txt'
    ])
  })

  it('refuses an empty selection', () => {
    expect(() => menuPaths([])).toThrow(/at least one path/)
  })
})

describe('splitMenuText', () => {
  it('removes mnemonic ampersands, keeping a doubled one as a literal &', () => {
    expect(splitMenuText('Ne&w')).toEqual({ label: 'New', accelerator: null })
    expect(splitMenuText('Open w&ith C&ursor')).toEqual({
      label: 'Open with Cursor',
      accelerator: null
    })
    expect(splitMenuText('Tom && Jerry')).toEqual({ label: 'Tom & Jerry', accelerator: null })
  })

  it('splits off the accelerator after a tab', () => {
    expect(splitMenuText('&Undo Rename\tCtrl+Z')).toEqual({
      label: 'Undo Rename',
      accelerator: 'Ctrl+Z'
    })
  })
})

describe('queryFlags', () => {
  it('asks for the normal menu with Rename, plus the extended verbs on Shift', () => {
    expect(queryFlags({ extendedVerbs: false })).toBe(CMF_NORMAL | CMF_CANRENAME)
    expect(queryFlags({ extendedVerbs: true })).toBe(CMF_NORMAL | CMF_CANRENAME | CMF_EXTENDEDVERBS)
  })

  it('marks a menu for items (not the background), as DefView does', () => {
    expect(queryFlags({ extendedVerbs: false, items: true })).toBe(
      CMF_NORMAL | CMF_CANRENAME | CMF_ITEMMENU
    )
  })

  it('tells handlers when a verb is invoked without showing the menu', () => {
    expect(queryFlags({ extendedVerbs: false, forInvoke: true })).toBe(CMF_OPTIMIZEFORINVOKE)
  })
})

describe('placeTaskyardItems (Taskyard id mapping)', () => {
  const items: TaskyardMenuItem[] = [
    {
      kind: 'submenu',
      label: 'Taskyard',
      items: [
        { kind: 'item', id: 'new-group', label: 'New group here' },
        { kind: 'separator' },
        { kind: 'item', id: 'settings', label: 'Taskyard settings', disabled: true }
      ]
    },
    { kind: 'item', id: 'remove-from-group', label: 'Remove from group', checked: true }
  ]

  it('numbers every clickable item from 0x8000 in menu order and maps the numbers back to ids', () => {
    const placed = placeTaskyardItems(items)
    expect([...placed.idByCommand]).toEqual([
      [0x8000, 'new-group'],
      [0x8001, 'settings'],
      [0x8002, 'remove-from-group']
    ])
    expect(placed.items).toEqual([
      {
        kind: 'submenu',
        label: 'Taskyard',
        items: [
          {
            kind: 'item',
            command: 0x8000,
            label: 'New group here',
            disabled: false,
            checked: false
          },
          { kind: 'separator' },
          {
            kind: 'item',
            command: 0x8001,
            label: 'Taskyard settings',
            disabled: true,
            checked: false
          }
        ]
      },
      { kind: 'item', command: 0x8002, label: 'Remove from group', disabled: false, checked: true }
    ])
  })

  it('refuses duplicate ids (a click could not be told apart)', () => {
    expect(() =>
      placeTaskyardItems([
        { kind: 'item', id: 'a', label: 'A' },
        { kind: 'submenu', label: 'S', items: [{ kind: 'item', id: 'a', label: 'A again' }] }
      ])
    ).toThrow(/duplicate Taskyard menu id "a"/)
  })
})

describe('separatorsToRemove', () => {
  it('removes leading, trailing and doubled separators (after hiding items)', () => {
    expect(
      separatorsToRemove(['separator', 'item', 'separator', 'separator', 'item', 'separator'])
    ).toEqual([0, 3, 5])
    expect(separatorsToRemove(['item', 'separator', 'item'])).toEqual([])
    expect(separatorsToRemove(['separator', 'separator'])).toEqual([0, 1])
  })
})

describe('pruneMenu', () => {
  const tree = [
    submenu('View', [
      item(1, 'Large icons', 'viewlogicaliconslarge'),
      item(2, 'List', 'viewlogicallist')
    ]),
    submenu('Group by', [item(3, 'Name'), item(4, 'Ascending', 'groupascending')]),
    item(5, 'Refresh', 'refresh'),
    separator,
    item(6, 'Customize this folder...', 'customize'),
    separator,
    item(7, 'Paste', 'paste'),
    separator,
    submenu('Only hidden', [item(8, 'Gone', 'gone')])
  ]

  it('removes hidden verbs, whole submenus named by a verb, emptied submenus and loose separators', () => {
    const pruned = pruneMenu(tree, {
      hideVerbs: ['viewlogicallist', 'customize', 'gone'],
      hideSubmenus: ['groupascending']
    })
    expect(pruned.map((entry) => (entry.separator ? '---' : entry.label))).toEqual([
      'View',
      'Refresh',
      '---',
      'Paste'
    ])
    expect(pruned[0].submenu!.map((entry) => entry.label)).toEqual(['Large icons'])
  })

  it('keeps the tree as it is when nothing is hidden', () => {
    expect(pruneMenu(tree, { hideVerbs: [], hideSubmenus: [] })).toEqual(tree)
  })
})

describe('verbCommands', () => {
  it('finds the ids of items with the given verbs anywhere in the tree', () => {
    const tree = [
      item(1, 'Open', 'open'),
      submenu('View', [
        item(2, 'Large icons', 'viewlogicaliconslarge'),
        item(3, 'Auto arrange', 'arrangeauto')
      ]),
      item(4, 'Customize this folder', 'customize')
    ]
    expect(verbCommands(tree, ['arrangeauto', 'customize', 'missing'])).toEqual([3, 4])
  })
})

describe('resolveCommand', () => {
  const tree: ShellMenuItem[] = [
    submenu('View', [
      item(1, 'Large icons', 'viewlogicaliconslarge'),
      item(2, 'Small icons', 'viewlogicaliconssmall')
    ]),
    submenu('Sort by', [
      item(3, 'Name'),
      item(4, 'Size'),
      separator,
      item(5, 'Ascending', 'sortascending')
    ]),
    item(6, 'Refresh', 'refresh'),
    separator,
    submenu('New', [item(7, 'Folder', 'NewFolder'), item(8, 'Text Document', '.txt')]),
    item(9, 'Rename', 'rename'),
    item(10, 'Shell thing')
  ]
  const idByCommand = new Map([[0x8000, 'new-group']])
  const rules = {
    interceptVerbs: ['refresh', 'rename'],
    interceptSubmenus: ['sortascending', 'viewlogicaliconslarge']
  }

  it('treats 0 (TrackPopupMenuEx returned nothing) as a dismissed menu', () => {
    expect(resolveCommand(0, { tree, idByCommand, ...rules })).toEqual({ kind: 'dismissed' })
  })

  it('maps a Taskyard command back to its id', () => {
    expect(resolveCommand(0x8000, { tree, idByCommand, ...rules })).toEqual({
      kind: 'taskyard',
      id: 'new-group'
    })
  })

  it('intercepts a listed verb instead of invoking it', () => {
    expect(resolveCommand(6, { tree, idByCommand, ...rules })).toEqual({
      kind: 'intercepted',
      verb: 'refresh',
      label: 'Refresh',
      path: []
    })
  })

  it('intercepts every item of a submenu identified by one of its verbs, even items without a verb', () => {
    expect(resolveCommand(4, { tree, idByCommand, ...rules })).toEqual({
      kind: 'intercepted',
      verb: null,
      label: 'Size',
      path: ['Sort by']
    })
    expect(resolveCommand(2, { tree, idByCommand, ...rules })).toEqual({
      kind: 'intercepted',
      verb: 'viewlogicaliconssmall',
      label: 'Small icons',
      path: ['View']
    })
  })

  it('invokes any other shell command by its offset from the first shell id', () => {
    expect(resolveCommand(8, { tree, idByCommand, ...rules })).toEqual({
      kind: 'invoke',
      offset: 8 - SHELL_COMMAND_FIRST,
      verb: '.txt',
      label: 'Text Document',
      path: ['New']
    })
    expect(resolveCommand(10, { tree, idByCommand, ...rules })).toEqual({
      kind: 'invoke',
      offset: 9,
      verb: null,
      label: 'Shell thing',
      path: []
    })
  })

  it('still invokes a shell command that the menu tree does not list (a handler added it late)', () => {
    expect(resolveCommand(0x1234, { tree, idByCommand, ...rules })).toEqual({
      kind: 'invoke',
      offset: 0x1234 - SHELL_COMMAND_FIRST,
      verb: null,
      label: '',
      path: []
    })
  })

  it('treats an unknown id at or above 0x8000 as dismissed (never invokes it)', () => {
    expect(resolveCommand(0x8005, { tree, idByCommand, ...rules })).toEqual({ kind: 'dismissed' })
  })
})
