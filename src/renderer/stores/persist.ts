import type { StoreFiles, StoreName } from '@shared/ipc'
import { createSyncedDoc, type SyncedDoc, type SyncTransport } from '@shared/sync-doc'
import { getBridge } from '../lib/bridge'
import { saveFailedToast } from '../lib/storage-messages'
import { useUiStore } from './ui'

/** How a persisted store talks to main; tests pass a fake transport. */
export interface StoreSyncOptions<N extends StoreName> {
  transport?: SyncTransport<StoreFiles[N]>
  onSaveError?: (error: unknown) => void
}

/** Saves through `window.taskyard.storage.save`, resolved at call time (tests install a fake). */
export function bridgeTransport<N extends StoreName>(store: N): SyncTransport<StoreFiles[N]> {
  return { save: (request) => getBridge().storage.save(store, request) }
}

/** A save main rejected outright (a bug, not a conflict): log it and tell the user. */
export function reportSaveFailure(store: StoreName): (error: unknown) => void {
  return (error) => {
    console.error(`storage: saving ${store} failed`, error)
    useUiStore.getState().pushToast(saveFailedToast(store))
  }
}

export interface StoreDoc<T> {
  /** The live synced document. */
  readonly current: SyncedDoc<T>
  /** Disposes the live document (late replies, queued saves and retries die with it) and starts a fresh one. */
  reset(): SyncedDoc<T>
}

/** The synced document behind a persisted zustand store. */
export function createStoreDoc<N extends StoreName>(
  store: N,
  initial: () => StoreFiles[N],
  onView: (view: StoreFiles[N]) => void,
  options: StoreSyncOptions<N>
): StoreDoc<StoreFiles[N]> {
  const create = (): SyncedDoc<StoreFiles[N]> =>
    createSyncedDoc<StoreFiles[N]>({
      initial: initial(),
      transport: options.transport ?? bridgeTransport(store),
      onView,
      onError: options.onSaveError ?? reportSaveFailure(store)
    })
  let current = create()
  return {
    get current() {
      return current
    },
    reset() {
      current.dispose()
      current = create()
      return current
    }
  }
}
