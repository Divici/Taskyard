import { describe, expect, it, vi } from 'vitest'
import type { DesktopItem } from '@shared/schema'
import { createItemsStore } from './items'

function item(id: string, patch: Partial<DesktopItem> = {}): DesktopItem {
  return {
    id,
    path: `C:\\Users\\me\\Desktop\\${id.replace(':', '-')}.txt`,
    name: id.replace(':', '-'),
    ext: '.txt',
    kind: 'file',
    mtimeMs: 1,
    sizeBytes: 10,
    readonly: false,
    placeholder: false,
    ...patch
  }
}

describe('items store', () => {
  it('hydrate(list) indexes items by id and replaces what was there', () => {
    const store = createItemsStore()
    store.getState().hydrate([item('1:1'), item('1:2')])

    store.getState().hydrate([item('1:2'), item('1:3')])

    expect(Object.keys(store.getState().byId).sort()).toEqual(['1:2', '1:3'])
    expect(store.getState().byId['1:3']).toEqual(item('1:3'))
    expect(store.getState().hydrated).toBe(true)
  })

  it('hydrate keeps icons that arrived early for listed items and drops the rest', () => {
    const store = createItemsStore()
    store.getState().setIcon('1:1', 32, 'data:a')
    store.getState().setIcon('9:9', 32, 'data:gone')

    store.getState().hydrate([item('1:1')])

    expect(store.getState().icons).toEqual({ '1:1': { px: 32, dataUrl: 'data:a' } })
  })

  it('applyChange adds, removes and updates items', () => {
    const store = createItemsStore()
    store.getState().hydrate([item('1:1'), item('1:2')])
    store.getState().setIcon('1:2', 32, 'data:x')

    store.getState().applyChange({
      added: [item('1:3')],
      removed: ['1:2'],
      changed: [item('1:1', { sizeBytes: 99 })]
    })

    const { byId, icons } = store.getState()
    expect(Object.keys(byId).sort()).toEqual(['1:1', '1:3'])
    expect(byId['1:1'].sizeBytes).toBe(99)
    expect(icons).toEqual({})
  })

  it('applyChange treats a changed item it has not seen as added', () => {
    const store = createItemsStore()
    store.getState().hydrate([])

    store.getState().applyChange({ added: [], removed: [], changed: [item('1:5')] })

    expect(store.getState().byId['1:5']).toEqual(item('1:5'))
  })

  it('applyRenamed(id, path) moves the item to its new path and keeps the id', () => {
    const store = createItemsStore()
    store
      .getState()
      .hydrate([item('1:1', { path: 'C:\\Desktop\\old.TXT', name: 'old', ext: '.TXT' })])

    store.getState().applyRenamed('1:1', 'C:\\Desktop\\Quarterly report.final.pdf')

    expect(store.getState().byId['1:1']).toMatchObject({
      id: '1:1',
      path: 'C:\\Desktop\\Quarterly report.final.pdf',
      name: 'Quarterly report.final',
      ext: '.pdf'
    })
  })

  it('applyRenamed never splits a folder name', () => {
    const store = createItemsStore()
    store.getState().hydrate([item('1:1', { kind: 'folder', ext: '', name: 'Stuff' })])

    store.getState().applyRenamed('1:1', 'C:\\Desktop\\Stuff.2024')

    expect(store.getState().byId['1:1']).toMatchObject({ name: 'Stuff.2024', ext: '' })
  })

  it('applyRenamed ignores an unknown id', () => {
    const store = createItemsStore()
    store.getState().hydrate([item('1:1')])
    const before = store.getState().byId

    store.getState().applyRenamed('7:7', 'C:\\Desktop\\x.txt')

    expect(store.getState().byId).toBe(before)
  })

  it('onItemsChanged: the reconcile seam (Phase 7) hears the present ids after hydrate and applyChange', () => {
    const store = createItemsStore()
    const reconcile = vi.fn()
    const unsubscribe = store.getState().onItemsChanged(reconcile)

    store.getState().hydrate([item('1:1'), item('1:2')])
    expect(reconcile).toHaveBeenLastCalledWith(['1:1', '1:2'])

    store.getState().applyChange({ added: [item('1:3')], removed: ['1:1'], changed: [] })
    expect(reconcile).toHaveBeenLastCalledWith(['1:2', '1:3'])
    expect(reconcile).toHaveBeenCalledTimes(2)

    // Renames and icons change no presence: no reconcile.
    store.getState().applyRenamed('1:2', 'C:\\Desktop\\b.txt')
    store.getState().setIcon('1:2', 32, 'data:x')
    expect(reconcile).toHaveBeenCalledTimes(2)

    unsubscribe()
    store.getState().applyChange({ added: [], removed: ['1:2'], changed: [] })
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  it('works with no listener, and a throwing listener neither breaks the update nor the others', () => {
    const store = createItemsStore()
    store.getState().hydrate([item('1:1')])
    expect(Object.keys(store.getState().byId)).toEqual(['1:1'])

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const good = vi.fn()
    store.getState().onItemsChanged(() => {
      throw new Error('reconcile bug')
    })
    store.getState().onItemsChanged(good)

    store.getState().applyChange({ added: [item('1:2')], removed: [], changed: [] })

    expect(Object.keys(store.getState().byId)).toEqual(['1:1', '1:2'])
    expect(good).toHaveBeenCalledExactlyOnceWith(['1:1', '1:2'])
    expect(error).toHaveBeenCalledWith(
      'items: an onItemsChanged listener failed',
      expect.any(Error)
    )
  })

  it('setIcon(id, px, dataUrl) stores the icon and keeps the sharpest one', () => {
    const store = createItemsStore()
    store.getState().hydrate([item('1:1')])

    store.getState().setIcon('1:1', 32, 'data:32')
    expect(store.getState().icons['1:1']).toEqual({ px: 32, dataUrl: 'data:32' })

    store.getState().setIcon('1:1', 96, 'data:96')
    store.getState().setIcon('1:1', 32, 'data:32-late')
    expect(store.getState().icons['1:1']).toEqual({ px: 96, dataUrl: 'data:96' })

    store.getState().setIcon('1:1', 96, 'data:96-new')
    expect(store.getState().icons['1:1']).toEqual({ px: 96, dataUrl: 'data:96-new' })
  })
})
