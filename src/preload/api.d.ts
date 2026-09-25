import type { DesktopItem } from '@shared/schema'
import type {
  DesktopActionResult,
  DesktopIcon,
  DisplayInfo,
  MoveToDesktopResult,
  RenameResult,
  UndoMoveResult,
  IpcEventName,
  IpcEvents,
  SaveRequest,
  SaveResult,
  StorageStatus,
  StoreFiles,
  StoreName,
  StoreSnapshot,
  ThemeInfo,
  WallpaperInfo
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

  /** The desktop folders' items and the file operations on them (main: src/main/desktop). */
  desktop: {
    /** Every item main knows (waits for the boot scan). */
    list(): Promise<DesktopItem[]>
    /** `.url` → browser; anything else → its default app. */
    open(id: string): Promise<DesktopActionResult>
    showInFolder(id: string): Promise<DesktopActionResult>
    /** `newName` is a file name (with extension); never replaces a file. Refused when readonly. */
    rename(id: string, newName: string): Promise<RenameResult>
    /** To the Recycle Bin; refused when readonly. */
    trash(id: string): Promise<DesktopActionResult>
    /** Explorer drop: moves into the user's Desktop (journaled, verified); one outcome per path. */
    moveToDesktop(paths: string[]): Promise<MoveToDesktopResult>
    undoMove(token: string): Promise<UndoMoveResult>
    /** Scans again; the full list arrives as desktop:changed. */
    rescan(): Promise<void>
    /** Every icon main has sent so far ({id, px, dataUrl}); later ones arrive as desktop:icon. */
    icons(): Promise<DesktopIcon[]>
  }

  theme: {
    /** The Windows app theme and transparency setting; then follow `theme:changed`. */
    get(): Promise<ThemeInfo>
  }

  wallpaper: {
    /** What this display's wallpaper layer paints; refetch on `wallpaper:changed`. */
    get(displayId: number): Promise<WallpaperInfo | null>
  }

  /** Subscribes to a main → renderer event; returns the unsubscribe. */
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
}

declare global {
  interface Window {
    taskyard: TaskyardApi
  }
}
