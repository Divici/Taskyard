import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { defaultSettings } from '@shared/defaults'
import type { StoreSnapshot } from '@shared/ipc'
import type { SettingsFile } from '@shared/schema'
import { createStoreDoc, type StoreSyncOptions } from './persist'

export type SettingsPatch = Partial<Omit<SettingsFile, 'version'>>

export interface SettingsState {
  settings: SettingsFile
  hydrated: boolean
  /** Main's settings at a revision: the loaded file or a `storage:changed` event. Never saves. */
  receive(snapshot: StoreSnapshot<'settings'>): void
  /** Changes only the patched fields and persists the file. */
  update(patch: SettingsPatch): void
  /** Forgets main's data, the revision and unsaved changes; back to unhydrated (tests). */
  reset(): void
}

export function createSettingsStore(
  options: StoreSyncOptions<'settings'> = {}
): UseBoundStore<StoreApi<SettingsState>> {
  return create<SettingsState>()((set) => {
    const doc = createStoreDoc(
      'settings',
      defaultSettings,
      (settings) => set({ settings }),
      options
    )

    return {
      settings: doc.current.view,
      hydrated: false,

      receive(snapshot) {
        doc.current.receive(snapshot)
        set({ hydrated: doc.current.hydrated })
      },

      update(patch) {
        // Copied now; replayed on newer settings if another window saved first, and then only
        // these fields change.
        const change = { ...patch }
        doc.current.mutate((settings) =>
          Object.entries(change).every(
            ([key, value]) => settings[key as keyof SettingsFile] === value
          )
            ? settings
            : { ...settings, ...change }
        )
      },

      reset() {
        set({ settings: doc.reset().view, hydrated: false })
      }
    }
  })
}

export const useSettingsStore = createSettingsStore()
