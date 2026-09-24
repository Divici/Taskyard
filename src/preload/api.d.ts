import type {
  DisplayInfo,
  IpcEventName,
  IpcEvents,
  SaveRequest,
  SaveResult,
  StorageStatus,
  StoreFiles,
  StoreName,
  StoreSnapshot
} from '@shared/ipc'

/** Surface the sandboxed preload exposes to the renderer as `window.taskyard`. */
export interface TaskyardApi {
  versions: {
    electron: string
    chrome: string
    node: string
  }

  storage: {
    /** The store's current data and revision in main (after boot-time migration/recovery). */
    load<N extends StoreName>(store: N): Promise<StoreSnapshot<N>>
    /**
     * Saves the whole file if `baseRevision` is still main's revision; otherwise replies `stale`
     * with main's current data. Accepted saves are validated exactly, written debounced (300 ms)
     * and atomically, and broadcast to every window (the sender too) as `storage:changed`.
     */
    save<N extends StoreName>(store: N, request: SaveRequest<StoreFiles[N]>): Promise<SaveResult<N>>
    /** Files in read-only mode and files recovered at boot. */
    status(): Promise<StorageStatus>
  }

  app: {
    quit(): Promise<void>
    /** Only `ms-settings:` and `https:` URLs; anything else rejects. */
    openExternal(url: string): Promise<void>
  }

  display: {
    /** This window's display (id from its URL): bounds, work area, scale factor; null if unknown. */
    get(id: number): Promise<DisplayInfo | null>
    list(): Promise<DisplayInfo[]>
  }

  /** Subscribes to a main → renderer event; returns the unsubscribe. */
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
}

declare global {
  interface Window {
    taskyard: TaskyardApi
  }
}
