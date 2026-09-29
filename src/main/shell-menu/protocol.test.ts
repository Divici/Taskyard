import { describe, expect, it } from 'vitest'
import type { ShellMenuItem } from '../win32/shell-menu-api'
import { parseHelperMessage, parseHelperRequest, type HelperRequest } from './protocol'

const showRequest: HelperRequest = {
  type: 'show',
  id: 7,
  target: { kind: 'desktop-background' },
  point: { x: 1200, y: -40 },
  extendedVerbs: true,
  taskyardItems: [
    {
      kind: 'submenu',
      label: 'Taskyard',
      items: [
        { kind: 'item', id: 'new-group', label: 'New group here' },
        { kind: 'separator' },
        {
          kind: 'submenu',
          label: 'Deeper',
          items: [{ kind: 'item', id: 'x', label: 'X', checked: true }]
        }
      ]
    }
  ],
  interceptVerbs: ['rename', 'refresh'],
  interceptSubmenus: ['sortascending'],
  hideVerbs: ['customize'],
  hideSubmenus: ['groupascending'],
  replaceSubmenus: [
    {
      match: { verb: 'viewlogicaliconslarge' },
      items: [
        {
          kind: 'item',
          id: 'icon-large',
          label: 'Large icons',
          labelFrom: { verb: 'viewlogicaliconslarge' },
          radio: true,
          checked: true
        },
        { kind: 'separator' },
        {
          kind: 'item',
          id: 'sort-name',
          label: 'Name',
          labelFrom: { submenu: 'sortascending', index: 0 }
        }
      ]
    },
    { match: { label: 'Sort by' }, label: 'Sort by', items: [] }
  ],
  returnFocusTo: '4660'
}

describe('parseHelperRequest (main → helper)', () => {
  it('accepts show, enumerate and invoke requests for every target kind', () => {
    expect(parseHelperRequest(showRequest)).toEqual(showRequest)
    // Phase 3: the window to give the foreground back to is optional.
    const { returnFocusTo: _unused, ...withoutFocus } = showRequest as Extract<
      HelperRequest,
      { type: 'show' }
    >
    void _unused
    expect(parseHelperRequest(withoutFocus)).toEqual(withoutFocus)
    const enumerate: HelperRequest = {
      type: 'enumerate',
      id: 1,
      target: { kind: 'folder-background', path: 'C:\\Temp\\x' },
      extendedVerbs: false,
      source: 'default-menu',
      pasteState: true
    }
    expect(parseHelperRequest(enumerate)).toEqual(enumerate)
    const invoke: HelperRequest = {
      type: 'invoke',
      id: 2,
      target: { kind: 'items', paths: ['C:\\Temp\\a.txt', 'C:\\Temp\\b.txt'] },
      verb: 'properties'
    }
    expect(parseHelperRequest(invoke)).toEqual(invoke)
    expect(parseHelperRequest({ type: 'shutdown' })).toEqual({ type: 'shutdown' })
  })

  it('rejects malformed requests', () => {
    const bad: unknown[] = [
      null,
      { type: 'launch-missiles', id: 1 },
      { ...showRequest, id: 0 },
      { ...showRequest, id: 1.5 },
      { ...showRequest, point: { x: 1.5, y: 0 } },
      { ...showRequest, target: { kind: 'items', paths: [] } },
      { ...showRequest, target: { kind: 'folder-background', path: '' } },
      { ...showRequest, taskyardItems: [{ kind: 'item', id: '', label: 'x' }] },
      { type: 'invoke', id: 3, target: { kind: 'desktop-background' }, verb: '' },
      { ...showRequest, replaceSubmenus: [{ match: {}, items: [] }] },
      { ...showRequest, returnFocusTo: '0x1234' },
      { ...showRequest, returnFocusTo: '' },
      { ...showRequest, replaceSubmenus: [{ match: { verb: '' }, items: [] }] },
      {
        ...showRequest,
        taskyardItems: [
          { kind: 'item', id: 'a', label: 'A', labelFrom: { submenu: 'x', index: -1 } }
        ]
      },
      {
        type: 'enumerate',
        id: 3,
        target: { kind: 'desktop-background' },
        extendedVerbs: false,
        source: 'x'
      }
    ]
    for (const message of bad) expect(() => parseHelperRequest(message)).toThrow()
  })
})

describe('parseHelperMessage (helper → main)', () => {
  const tree: ShellMenuItem[] = [
    {
      id: 0,
      label: 'New',
      accelerator: null,
      verb: null,
      separator: false,
      disabled: false,
      checked: false,
      submenu: [
        {
          id: 12,
          label: 'Folder',
          accelerator: null,
          verb: 'NewFolder',
          separator: false,
          disabled: false,
          checked: false,
          submenu: null
        }
      ]
    }
  ]

  it('accepts every message kind the helper sends', () => {
    const messages = [
      { type: 'ready', pid: 4242 },
      { type: 'fatal', message: 'koffi failed to load' },
      { type: 'showing', id: 3, ownerHwnd: '2039016' },
      { type: 'result', id: 3, result: { kind: 'show', outcome: { kind: 'dismissed' } } },
      {
        type: 'result',
        id: 3,
        result: { kind: 'show', outcome: { kind: 'taskyard', id: 'new-group' } }
      },
      {
        type: 'result',
        id: 3,
        result: {
          kind: 'show',
          outcome: { kind: 'intercepted', verb: null, label: 'Size', path: ['Sort by'] }
        }
      },
      {
        type: 'result',
        id: 3,
        result: {
          kind: 'show',
          outcome: { kind: 'invoked', verb: 'delete', label: 'Delete', path: [] }
        }
      },
      { type: 'result', id: 4, result: { kind: 'enumerate', items: tree } },
      { type: 'result', id: 5, result: { kind: 'invoke' } },
      {
        type: 'result',
        id: 3,
        result: {
          kind: 'show',
          outcome: {
            kind: 'invoke-failed',
            verb: 'openas',
            label: 'Choose another app',
            path: ['Open with'],
            message: 'x'
          }
        }
      },
      { type: 'error', id: 6, message: 'SHParseDisplayName failed' },
      { type: 'crash', message: 'TypeError: x is undefined' },
      { type: 'warn', message: 'shell-menu: cleanup failed: Error: x' }
    ]
    for (const message of messages) expect(parseHelperMessage(message)).toEqual(message)
  })

  it('rejects malformed messages (the helper runs third-party shell extensions)', () => {
    const bad: unknown[] = [
      'ready',
      { type: 'ready' },
      { type: 'showing', id: 3, ownerHwnd: '0x1f' },
      { type: 'result', id: 3, result: { kind: 'show', outcome: { kind: 'taskyard' } } },
      { type: 'result', id: 3, result: { kind: 'teleport' } }
    ]
    for (const message of bad) expect(() => parseHelperMessage(message)).toThrow()
  })
})
