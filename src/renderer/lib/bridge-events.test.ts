import { describe, expect, it } from 'vitest'
import { defaultSettings, emptyLayout, emptyTasks, newDisplayLayout } from '@shared/defaults'
import { EVENT_CHANNELS } from '@shared/ipc'
import type { DesktopItem } from '@shared/schema'
import { createItemsStore } from '../stores/items'
import { createLayoutStore } from '../stores/layout'
import { createSettingsStore } from '../stores/settings'
import { createTasksStore } from '../stores/tasks'
import { createUiStore } from '../stores/ui'
import { createFakeBridge } from '../test/fake-bridge'
import { subscribeBridgeEvents, type BridgeEventTargets } from './bridge-events'

const item: DesktopItem = {
  id: '1:2',
  path: 'C:\\Desktop\\a.txt',
  name: 'a',
  ext: '.txt',
  kind: 'file',
  mtimeMs: 1,
  sizeBytes: 1,
  readonly: false,
  placeholder: false
}

function targets(): BridgeEventTargets {
  return {
    items: createItemsStore(),
    settings: createSettingsStore(),
    layout: createLayoutStore(),
    tasks: createTasksStore(),
    ui: createUiStore()
  }
}

describe('subscribeBridgeEvents', () => {
  it('feeds desktop:icon into the items store, and leaves item changes to connectDesktop', () => {
    const bridge = createFakeBridge()
    const stores = targets()
    stores.items.getState().hydrate([item])
    subscribeBridgeEvents(bridge, stores)

    // desktop:changed / desktop:renamed are ordered against desktop:list in desktop-sync.ts.
    expect(bridge.listenerCount('desktop:changed')).toBe(0)
    expect(bridge.listenerCount('desktop:renamed')).toBe(0)
    bridge.emit('desktop:icon', { id: '1:2', px: 64, dataUrl: 'data:image/png;base64,AA' })

    expect(stores.items.getState().icons['1:2']).toEqual({
      px: 64,
      dataUrl: 'data:image/png;base64,AA'
    })
  })

  it('turns storage:recovered into a toast', () => {
    const bridge = createFakeBridge()
    const stores = targets()
    subscribeBridgeEvents(bridge, stores)

    bridge.emit('storage:recovered', {
      store: 'tasks',
      restoredFrom: 'backup',
      reason: 'invalid',
      corruptPath: 'C:\\t.json'
    })

    expect(stores.ui.getState().toasts).toEqual([
      expect.objectContaining({ id: 'storage-recovered:tasks', tone: 'warning' })
    ])
  })

  it('feeds storage:changed (with its revision) to the matching store without saving it back', async () => {
    const bridge = createFakeBridge()
    const stores = targets()
    subscribeBridgeEvents(bridge, stores)
    const settings = { ...defaultSettings(), accent: 'white' as const }
    const layout = {
      ...emptyLayout(),
      displays: [newDisplayLayout(2, { x: 2560, y: 0, width: 1920, height: 1080 })]
    }
    const tasks = {
      ...emptyTasks(),
      tasks: [{ id: 't', text: 'y', done: true, order: 1, createdAt: 2 }]
    }

    bridge.emit('storage:changed', { store: 'settings', revision: 2, data: settings })
    bridge.emit('storage:changed', { store: 'layout', revision: 5, data: layout })
    bridge.emit('storage:changed', { store: 'tasks', revision: 3, data: tasks })
    // An older revision arriving late is ignored.
    bridge.emit('storage:changed', { store: 'layout', revision: 4, data: emptyLayout() })

    expect(stores.settings.getState().settings).toEqual(settings)
    expect(stores.layout.getState().layout).toEqual(layout)
    expect(stores.tasks.getState().tasks).toEqual(tasks.tasks)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(bridge.storage.save).not.toHaveBeenCalled()
  })

  it('returns one unsubscribe that detaches every listener', () => {
    const bridge = createFakeBridge()
    const unsubscribe = subscribeBridgeEvents(bridge, targets())

    unsubscribe()

    for (const event of EVENT_CHANNELS) expect(bridge.listenerCount(event)).toBe(0)
  })
})
