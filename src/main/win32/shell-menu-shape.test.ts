import { describe, expect, it } from 'vitest'
import { ComError } from './com'
import {
  HRESULT_ERROR_CANCELLED,
  invokeOutcome,
  labelFor,
  findSubmenu,
  placeTaskyardMenus,
  placedToItems,
  replaceSubmenus,
  resolveLabels,
  runInvoke
} from './shell-menu-shape'
import { resolveCommand, TASKYARD_COMMAND_BASE, type ShellMenuItem } from './shell-menu-api'

function item(
  id: number,
  label: string,
  verb: string | null = null,
  extra: Partial<ShellMenuItem> = {}
): ShellMenuItem {
  return {
    id,
    label,
    accelerator: null,
    verb,
    separator: false,
    disabled: false,
    checked: false,
    submenu: null,
    ...extra
  }
}
const separator: ShellMenuItem = { ...item(0, ''), separator: true }
function submenu(label: string, items: ShellMenuItem[]): ShellMenuItem {
  return { ...item(0, label), submenu: items }
}

/** The shell-view Desktop background as the spike read it (localized labels, disabled sort). */
const desktop: ShellMenuItem[] = [
  submenu('View', [
    item(1, 'Grandes icônes', 'viewlogicaliconslarge'),
    item(2, 'Icônes moyennes', 'viewlogicaliconsmedium'),
    item(3, 'Petites icônes', 'viewlogicaliconssmall'),
    item(4, 'List', 'viewlogicallist'),
    separator,
    item(5, 'Auto arrange', 'arrangeauto', { disabled: true }),
    item(6, 'Align to grid', 'arrangeautogrid', { disabled: true })
  ]),
  submenu('Sort by', [
    item(7, 'Nom', null, { disabled: true }),
    item(8, 'Taille', null, { disabled: true }),
    item(9, 'Type', null, { disabled: true }),
    item(10, 'Modifié le', null, { disabled: true }),
    separator,
    item(11, 'Ascending', 'sortascending', { disabled: true })
  ]),
  submenu('Group by', [item(12, 'Name'), separator, item(13, 'More...', 'viewcolsettings')]),
  item(14, 'Refresh', 'refresh'),
  separator,
  item(15, 'Paste', 'paste'),
  submenu('New', [item(16, 'Folder', 'NewFolder')])
]

describe('findSubmenu / labelFor (reusing Windows’ localized labels)', () => {
  it('finds a submenu by a verb it holds, or by its label without mnemonics, any case', () => {
    expect(findSubmenu(desktop, { verb: 'sortascending' })?.label).toBe('Sort by')
    expect(findSubmenu(desktop, { label: 'group BY' })?.label).toBe('Group by')
    expect(findSubmenu(desktop, { label: '&View' })?.label).toBe('View')
    expect(findSubmenu(desktop, { verb: 'nope' })).toBeUndefined()
  })

  it('reads a label by verb, or by position among a submenu’s non-separator items', () => {
    expect(labelFor(desktop, { verb: 'viewlogicaliconssmall' })).toBe('Petites icônes')
    expect(labelFor(desktop, { submenu: 'sortascending', index: 3 })).toBe('Modifié le')
    expect(labelFor(desktop, { submenu: 'sortascending', index: 9 })).toBeNull()
    expect(labelFor(desktop, { verb: 'missing' })).toBeNull()
  })

  it('resolves every labelFrom in a Taskyard tree, keeping the fallback label when Windows has none', () => {
    expect(
      resolveLabels(
        [
          {
            kind: 'item',
            id: 'large',
            label: 'Large icons',
            labelFrom: { verb: 'viewlogicaliconslarge' }
          },
          {
            kind: 'submenu',
            label: 'Inner',
            items: [
              {
                kind: 'item',
                id: 'name',
                label: 'Name',
                labelFrom: { submenu: 'sortascending', index: 0 }
              }
            ]
          },
          { kind: 'item', id: 'show', label: 'Show desktop icons', labelFrom: { verb: 'missing' } },
          { kind: 'separator' }
        ],
        desktop
      )
    ).toEqual([
      {
        kind: 'item',
        id: 'large',
        label: 'Grandes icônes',
        labelFrom: { verb: 'viewlogicaliconslarge' }
      },
      {
        kind: 'submenu',
        label: 'Inner',
        items: [
          {
            kind: 'item',
            id: 'name',
            label: 'Nom',
            labelFrom: { submenu: 'sortascending', index: 0 }
          }
        ]
      },
      { kind: 'item', id: 'show', label: 'Show desktop icons', labelFrom: { verb: 'missing' } },
      { kind: 'separator' }
    ])
  })
})

describe('placeTaskyardMenus', () => {
  it('numbers the top items, then each replacement, from 0x8000 with one shared id map', () => {
    const placed = placeTaskyardMenus(
      [{ kind: 'item', id: 'new-group', label: 'New group here' }],
      [
        {
          match: { verb: 'viewlogicaliconslarge' },
          items: [
            { kind: 'item', id: 'icon-large', label: 'Large icons', radio: true, checked: true },
            { kind: 'separator' },
            { kind: 'item', id: 'show-icons', label: 'Show desktop icons', checked: true }
          ]
        },
        {
          match: { verb: 'sortascending' },
          label: 'Sort',
          items: [{ kind: 'item', id: 'sort-name', label: 'Name' }]
        }
      ]
    )
    expect([...placed.idByCommand]).toEqual([
      [0x8000, 'new-group'],
      [0x8001, 'icon-large'],
      [0x8002, 'show-icons'],
      [0x8003, 'sort-name']
    ])
    expect(placed.replacements[0].items[0]).toEqual({
      kind: 'item',
      command: 0x8001,
      label: 'Large icons',
      disabled: false,
      checked: true,
      radio: true
    })
    expect(placed.replacements[1]).toMatchObject({
      match: { verb: 'sortascending' },
      label: 'Sort'
    })
  })

  it('refuses an id used both on top and in a replacement', () => {
    expect(() =>
      placeTaskyardMenus(
        [{ kind: 'item', id: 'a', label: 'A' }],
        [{ match: { verb: 'x' }, items: [{ kind: 'item', id: 'a', label: 'A' }] }]
      )
    ).toThrow(/duplicate Taskyard menu id "a"/)
  })
})

describe('replaceSubmenus (the fake’s model of what the helper does to the HMENU)', () => {
  it('swaps the matched submenu’s items in place, keeping Windows’ label unless one is given', () => {
    const placed = placeTaskyardMenus(
      [],
      [
        {
          match: { verb: 'viewlogicaliconslarge' },
          items: [
            { kind: 'item', id: 'icon-small', label: 'Small icons', radio: true, checked: true }
          ]
        },
        {
          match: { label: 'sort by' },
          label: 'Trier',
          items: [{ kind: 'item', id: 'sort-size', label: 'Size' }]
        },
        { match: { verb: 'not-there' }, items: [{ kind: 'item', id: 'lost', label: 'Lost' }] }
      ]
    )
    const replaced = replaceSubmenus(desktop, placed.replacements)
    expect(replaced.map((entry) => entry.label)).toEqual(
      desktop.map((entry) => (entry.label === 'Sort by' ? 'Trier' : entry.label))
    )
    expect(replaced[0].submenu).toEqual([
      { ...item(TASKYARD_COMMAND_BASE, 'Small icons'), checked: true, radio: true }
    ])
    expect(replaced[1].submenu).toEqual([item(TASKYARD_COMMAND_BASE + 1, 'Size')])
  })

  it('turns placed items into menu entries (separators, submenus, states)', () => {
    const placed = placeTaskyardMenus(
      [
        {
          kind: 'submenu',
          label: 'Taskyard',
          items: [{ kind: 'item', id: 'a', label: 'A', disabled: true }]
        },
        { kind: 'separator' }
      ],
      []
    )
    expect(placedToItems(placed.top)).toEqual([
      submenu('Taskyard', [{ ...item(TASKYARD_COMMAND_BASE, 'A'), disabled: true }]),
      separator
    ])
  })
})

describe('resolveCommand on a background menu (view state guard)', () => {
  const context = {
    tree: desktop,
    idByCommand: new Map<number, string>(),
    interceptVerbs: [],
    interceptSubmenus: []
  }

  it('never invokes a view, arrange, sort or group command of the invisible view, even unlisted', () => {
    for (const [id, verb, label, path] of [
      [2, 'viewlogicaliconsmedium', 'Icônes moyennes', ['View']],
      [5, 'arrangeauto', 'Auto arrange', ['View']],
      [8, null, 'Taille', ['Sort by']],
      [12, null, 'Name', ['Group by']],
      [13, 'viewcolsettings', 'More...', ['Group by']]
    ] as const) {
      expect(resolveCommand(id, { ...context, guardViewState: true })).toEqual({
        kind: 'intercepted',
        verb,
        label,
        path
      })
    }
  })

  it('still invokes ordinary background commands (Paste, New ▸)', () => {
    expect(resolveCommand(15, { ...context, guardViewState: true })).toMatchObject({
      kind: 'invoke',
      verb: 'paste'
    })
    expect(resolveCommand(16, { ...context, guardViewState: true })).toMatchObject({
      kind: 'invoke',
      verb: 'NewFolder'
    })
  })

  it('leaves file menus alone (no guard)', () => {
    expect(resolveCommand(2, { ...context, guardViewState: false })).toMatchObject({
      kind: 'invoke'
    })
  })
})

describe('invokeOutcome / runInvoke (a failed invoke after the user chose)', () => {
  const chosen = {
    kind: 'invoke' as const,
    offset: 7,
    verb: 'openas',
    label: 'Choose another app',
    path: ['Open with']
  }

  it('reports a successful invoke as invoked', () => {
    expect(invokeOutcome(chosen, () => undefined)).toEqual({
      kind: 'invoked',
      verb: 'openas',
      label: 'Choose another app',
      path: ['Open with']
    })
  })

  it('treats HRESULT_FROM_WIN32(ERROR_CANCELLED) — a cancelled UAC prompt or dialog — as success', () => {
    expect(HRESULT_ERROR_CANCELLED).toBe(0x800704c7 | 0)
    const cancelled = (): void => {
      throw new ComError(
        'IContextMenu::InvokeCommand failed: HRESULT 0x800704c7',
        HRESULT_ERROR_CANCELLED
      )
    }
    expect(invokeOutcome(chosen, cancelled)).toMatchObject({ kind: 'invoked' })
    expect(() => runInvoke(cancelled)).not.toThrow()
  })

  it('turns any other failure into invoke-failed with the message (not a rejection)', () => {
    const failing = (): void => {
      throw new ComError('IContextMenu::InvokeCommand failed: HRESULT 0x80070005', 0x80070005 | 0)
    }
    expect(invokeOutcome(chosen, failing)).toEqual({
      kind: 'invoke-failed',
      verb: 'openas',
      label: 'Choose another app',
      path: ['Open with'],
      message: 'IContextMenu::InvokeCommand failed: HRESULT 0x80070005'
    })
    expect(() => runInvoke(failing)).toThrow(/0x80070005/)
  })
})
