import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/defaults'
import type { SettingsFile } from '@shared/schema'
import { createFakeBridge, installFakeBridge } from '../test/fake-bridge'
import { FakeMain } from '@shared/test/fake-main'
import { createSettingsStore } from './settings'

describe('settings store', () => {
  it('starts from defaults and is not hydrated', () => {
    const store = createSettingsStore()

    expect(store.getState().settings).toEqual(defaultSettings())
    expect(store.getState().hydrated).toBe(false)
  })

  it('update merges a patch and persists the whole file against the current revision', async () => {
    const saved = { ...defaultSettings(), theme: 'dark' as const }
    const bridge = installFakeBridge(
      createFakeBridge({ files: { settings: saved }, revisions: { settings: 4 } })
    )
    const store = createSettingsStore()
    store.getState().receive({ revision: 4, data: saved })

    store.getState().update({ glassBlur: 24, accent: 'purple' })

    const expected = { ...defaultSettings(), theme: 'dark', glassBlur: 24, accent: 'purple' }
    expect(store.getState().settings).toEqual(expected)
    await vi.waitFor(() =>
      expect(bridge.storage.save).toHaveBeenCalledExactlyOnceWith('settings', {
        baseRevision: 4,
        data: expected
      })
    )
  })

  it('keeps a change made before hydration even when it equals the default', async () => {
    const saved = { ...defaultSettings(), theme: 'dark' as const }
    const bridge = installFakeBridge(createFakeBridge({ files: { settings: saved } }))
    const store = createSettingsStore()

    store.getState().update({ theme: 'system' }) // 'system' is the default the store starts with
    store.getState().receive({ revision: 1, data: saved })

    expect(store.getState().settings.theme).toBe('system')
    await vi.waitFor(() =>
      expect(bridge.storage.save).toHaveBeenCalledExactlyOnceWith('settings', {
        baseRevision: 1,
        data: { ...saved, theme: 'system' }
      })
    )
  })

  it('snapshots the patch when called', async () => {
    const bridge = installFakeBridge()
    const store = createSettingsStore()
    const patch: { glassBlur: number } = { glassBlur: 24 }

    store.getState().update(patch)
    patch.glassBlur = 3
    store.getState().receive({ revision: 1, data: defaultSettings() })

    await vi.waitFor(() => expect(bridge.storage.save).toHaveBeenCalled())
    const saved = bridge.storage.save.mock.calls.at(-1)?.[1].data as SettingsFile | undefined
    expect(saved?.glassBlur).toBe(24)
  })

  it('two windows changing different settings at once keep both changes', async () => {
    const main = new FakeMain<SettingsFile>(defaultSettings())
    const [a, b] = [main.connect(), main.connect()].map((window) => {
      const store = createSettingsStore({ transport: window.transport })
      window.receive = (snapshot) => store.getState().receive(snapshot)
      store.getState().receive(main.snapshot())
      return store
    })

    a.getState().update({ theme: 'light' })
    b.getState().update({ glassBlur: 30 })
    await main.settle()

    expect(main.data).toMatchObject({ theme: 'light', glassBlur: 30 })
    expect(a.getState().settings).toEqual(main.data)
    expect(b.getState().settings).toEqual(main.data)
  })
})
