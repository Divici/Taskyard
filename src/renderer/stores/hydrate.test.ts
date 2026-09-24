import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, emptyLayout, emptyTasks, newDisplayLayout } from '@shared/defaults'
import { createFakeBridge, installFakeBridge } from '../test/fake-bridge'
import { hydrateStores, type HydrationTargets } from './hydrate'
import { createLayoutStore } from './layout'
import { createSettingsStore } from './settings'
import { createTasksStore } from './tasks'
import { createUiStore } from './ui'

function targets(): HydrationTargets {
  return {
    settings: createSettingsStore(),
    layout: createLayoutStore(),
    tasks: createTasksStore(),
    ui: createUiStore()
  }
}

describe('hydrateStores', () => {
  it('loads settings, layout and tasks from main and hydrates each store', async () => {
    const settings = { ...defaultSettings(), theme: 'dark' as const }
    const layout = {
      ...emptyLayout(),
      displays: [newDisplayLayout(1, { x: 0, y: 0, width: 2560, height: 1440 })]
    }
    const tasks = {
      ...emptyTasks(),
      tasks: [{ id: 't', text: 'x', done: false, order: 0, createdAt: 0 }]
    }
    const bridge = createFakeBridge({ files: { settings, layout, tasks } })
    const stores = targets()

    await hydrateStores(bridge, stores)

    expect(stores.settings.getState()).toMatchObject({ settings, hydrated: true })
    expect(stores.layout.getState()).toMatchObject({ layout, hydrated: true })
    expect(stores.tasks.getState()).toMatchObject({ tasks: tasks.tasks, hydrated: true })
    expect(bridge.storage.load.mock.calls.map(([store]) => store).sort()).toEqual([
      'layout',
      'settings',
      'tasks'
    ])
    expect(bridge.storage.save).not.toHaveBeenCalled()
  })

  it('keeps the revision main loaded, so the first save is based on it', async () => {
    const bridge = installFakeBridge(createFakeBridge({ revisions: { layout: 6 } }))
    const stores = targets()

    await hydrateStores(bridge, stores)
    stores.layout.getState().ensureDisplay({ id: 1, bounds: { x: 0, y: 0, width: 10, height: 10 } })

    await vi.waitFor(() =>
      expect(bridge.storage.save).toHaveBeenCalledWith(
        'layout',
        expect.objectContaining({ baseRevision: 6 })
      )
    )
  })

  it('records read-only files and turns each recovery into a toast', async () => {
    const bridge = createFakeBridge()
    bridge.storage.status.mockResolvedValue({
      readOnly: [{ store: 'tasks', reason: 'future-version', version: 3 }],
      recovered: [
        {
          store: 'layout',
          restoredFrom: 'backup',
          reason: 'invalid',
          corruptPath:
            'C:\\Users\\me\\AppData\\Roaming\\Taskyard\\layout.corrupt-2026-09-23T10-15-30.123Z.json'
        },
        {
          store: 'settings',
          restoredFrom: 'defaults',
          reason: 'unreadable-json',
          corruptPath: 'C:\\x\\settings.corrupt-2026-09-23T10-15-30.123Z.json'
        }
      ]
    })
    const stores = targets()

    await hydrateStores(bridge, stores)

    const ui = stores.ui.getState()
    expect(ui.readOnly).toEqual([{ store: 'tasks', reason: 'future-version', version: 3 }])
    expect(ui.toasts).toEqual([
      expect.objectContaining({
        id: 'storage-recovered:layout',
        tone: 'warning',
        message: 'Taskyard couldn’t read your desktop layout, so it restored the last backup.',
        description:
          'The unreadable file was kept as layout.corrupt-2026-09-23T10-15-30.123Z.json.',
        durationMs: 10_000
      }),
      expect.objectContaining({
        id: 'storage-recovered:settings',
        tone: 'error',
        message: 'Taskyard couldn’t read your settings and started fresh.',
        durationMs: null
      })
    ])
  })

  it('does not stack duplicate toasts when it runs twice (React StrictMode)', async () => {
    const bridge = createFakeBridge()
    bridge.storage.status.mockResolvedValue({
      readOnly: [],
      recovered: [
        { store: 'layout', restoredFrom: 'backup', reason: 'invalid', corruptPath: 'C:\\l.json' }
      ]
    })
    const stores = targets()

    await hydrateStores(bridge, stores)
    await hydrateStores(bridge, stores)

    expect(stores.ui.getState().toasts).toHaveLength(1)
  })

  it('leaves the stores unhydrated, so nothing overwrites the files, when loading fails', async () => {
    const bridge = createFakeBridge()
    bridge.storage.load.mockRejectedValue(new Error('untrusted sender'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stores = targets()

    await hydrateStores(bridge, stores)

    expect(stores.settings.getState().hydrated).toBe(false)
    expect(stores.layout.getState().hydrated).toBe(false)
    expect(stores.tasks.getState().hydrated).toBe(false)
    expect(stores.ui.getState().toasts).toEqual([
      expect.objectContaining({
        id: 'storage-load-failed',
        tone: 'error',
        message: 'Taskyard couldn’t load your saved data. Changes won’t be saved this session.'
      })
    ])
    expect(error).toHaveBeenCalled()
  })
})
