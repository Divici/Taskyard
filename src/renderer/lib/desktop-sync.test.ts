import { describe, expect, it, vi } from 'vitest'
import type { DesktopItem } from '@shared/schema'
import { createItemsStore } from '../stores/items'
import { createUiStore } from '../stores/ui'
import { createFakeBridge } from '../test/fake-bridge'
import { connectDesktop, DESKTOP_LOAD_FAILED_TOAST } from './desktop-sync'

function item(id: string, name = id.replace(':', '-')): DesktopItem {
  return {
    id,
    path: `C:\\Users\\me\\Desktop\\${name}.txt`,
    name,
    ext: '.txt',
    kind: 'file',
    mtimeMs: 1,
    sizeBytes: 1,
    readonly: false,
    placeholder: false
  }
}

function targets(): {
  items: ReturnType<typeof createItemsStore>
  ui: ReturnType<typeof createUiStore>
} {
  return { items: createItemsStore(), ui: createUiStore() }
}

/** A promise the test resolves by hand, to hold desktop:list in flight. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('connectDesktop', () => {
  it('hydrates the items store from desktop:list', async () => {
    const bridge = createFakeBridge({ items: [item('1:1'), item('1:2')] })
    const stores = targets()

    connectDesktop(bridge, stores)
    await vi.waitFor(() => expect(stores.items.getState().hydrated).toBe(true))

    expect(Object.keys(stores.items.getState().byId)).toEqual(['1:1', '1:2'])
    expect(bridge.desktop.list).toHaveBeenCalledOnce()
  })

  it('replays, in order, the events that arrived while the list was in flight', async () => {
    const bridge = createFakeBridge()
    const list = deferred<DesktopItem[]>()
    bridge.desktop.list.mockReturnValueOnce(list.promise)
    const stores = targets()
    connectDesktop(bridge, stores)

    // Sent by main before it answered: already part of the list, replaying them is harmless.
    bridge.emit('desktop:changed', { added: [item('1:3')], removed: [], changed: [] })
    bridge.emit('desktop:renamed', { id: '1:3', path: 'C:\\Users\\me\\Desktop\\c.md' })
    bridge.emit('desktop:changed', { added: [], removed: ['1:1'], changed: [] })
    expect(stores.items.getState().hydrated).toBe(false)
    list.resolve([item('1:1'), item('1:2'), item('1:3')])
    await vi.waitFor(() => expect(stores.items.getState().hydrated).toBe(true))

    const { byId } = stores.items.getState()
    expect(Object.keys(byId).sort()).toEqual(['1:2', '1:3'])
    expect(byId['1:3']).toMatchObject({ name: 'c', ext: '.md' })
  })

  it('applies events directly once hydrated', async () => {
    const bridge = createFakeBridge({ items: [item('1:1')] })
    const stores = targets()
    connectDesktop(bridge, stores)
    await vi.waitFor(() => expect(stores.items.getState().hydrated).toBe(true))

    bridge.emit('desktop:changed', { added: [item('1:2')], removed: [], changed: [] })
    bridge.emit('desktop:renamed', { id: '1:1', path: 'C:\\Users\\me\\Desktop\\z.txt' })

    expect(stores.items.getState().byId['1:2']).toBeDefined()
    expect(stores.items.getState().byId['1:1'].name).toBe('z')
  })

  it('a failed list shows a toast and still applies the events it holds and later ones', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bridge = createFakeBridge()
    const list = deferred<DesktopItem[]>()
    bridge.desktop.list.mockReturnValueOnce(list.promise)
    const stores = targets()
    connectDesktop(bridge, stores)

    bridge.emit('desktop:changed', { added: [item('1:1')], removed: [], changed: [] })
    list.reject(new Error('main is gone'))
    await vi.waitFor(() => expect(stores.ui.getState().toasts).toHaveLength(1))
    bridge.emit('desktop:changed', { added: [item('1:2')], removed: [], changed: [] })

    expect(stores.ui.getState().toasts[0]).toMatchObject({
      id: DESKTOP_LOAD_FAILED_TOAST.id,
      tone: 'error'
    })
    expect(Object.keys(stores.items.getState().byId)).toEqual(['1:1', '1:2'])
    expect(error).toHaveBeenCalledWith('desktop: listing the desktop failed', expect.any(Error))
  })

  it('disconnect removes the listeners and ignores a late answer', async () => {
    const bridge = createFakeBridge()
    const list = deferred<DesktopItem[]>()
    bridge.desktop.list.mockReturnValueOnce(list.promise)
    const stores = targets()
    const disconnect = connectDesktop(bridge, stores)

    disconnect()
    list.resolve([item('1:1')])
    await Promise.resolve()
    await Promise.resolve()

    expect(bridge.listenerCount('desktop:changed')).toBe(0)
    expect(bridge.listenerCount('desktop:renamed')).toBe(0)
    expect(stores.items.getState().hydrated).toBe(false)
  })
})
