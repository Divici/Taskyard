import type { DesktopItem } from '@shared/schema'
import type {
  AppInfo,
  DesktopActionResult,
  DesktopIcon,
  DisplayInfo,
  MoveToDesktopResult,
  RenameResult,
  UndoMoveResult,
  IpcEventName,
  IpcEvents,
  PeekState,
  ShortcutStatus,
  ShellMenuShowRequest,
  ShellMenuShowResult,
  SaveRequest,
  SaveResult,
  StorageStatus,
  StoreFiles,
  StoreName,
  StoreSnapshot,
  ThemeInfo,
  TimerNotifyRequest,
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
    /** Phase 11: opens the data folder (settings, layout, tasks, logs) in Explorer. */
    openDataFolder(): Promise<boolean>
    /** Phase 11: name, version and data folder (the inspector's About). */
    info(): Promise<AppInfo>
  }

  display: {
    /** This window's display (id from its URL): bounds, work area, scale factor; null if unknown. */
    get(id: number): Promise<DisplayInfo | null>
    list(): Promise<DisplayInfo[]>
  }

  /** Phase 9: Peek lives in main (window manager + src/main/app/shortcuts.ts). */
  peek: {
    /** Whether Peek is on now; then follow `peek:changed`. */
    get(): Promise<PeekState>
    /** A text input in this window gained or lost focus: the idle unpeek waits while one has. */
    inputFocus(focused: boolean): Promise<void>
    /** Pointer or keyboard activity during a Peek: restarts the 8 s idle unpeek. */
    activity(): Promise<void>
    /** A click outside every group and panel during a Peek: ends it. */
    clickOutside(): Promise<void>
    /** The Peek shortcut's registration; then follow `peek:shortcut`. */
    shortcutStatus(): Promise<ShortcutStatus>
    /**
     * Phase 11: the settings inspector opened (Peek on, held until it closes) or closed (the hold
     * is released; the Peek ends on the idle timer or a click outside).
     */
    hold(on: boolean): Promise<void>
  }

  /** Phase 9: quick-hide, shared by every display (never persisted). */
  quickHide: {
    get(): Promise<boolean>
    /** Hides or shows the icons and groups on every display (`quickHide:changed` to all). */
    set(hidden: boolean): Promise<void>
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
    /**
     * Phase 8: hands the items' files to the OS drag of this window (call it after cancelling the
     * in-page drag). Resolves when the OS drag ends; false when nothing could be dragged.
     */
    startDrag(ids: string[]): Promise<boolean>
    /** Phase 8: whether another app's window is under the cursor (it covers the desktop there). */
    cursorOverOtherWindow(): Promise<boolean>
    /** Phase 8: the path of a File dropped from Explorer (`webUtils.getPathForFile`; '' if none). */
    pathForFile(file: File): string
  }

  theme: {
    /** The Windows app theme and transparency setting; then follow `theme:changed`. */
    get(): Promise<ThemeInfo>
  }

  wallpaper: {
    /** What this display's wallpaper layer paints; refetch on `wallpaper:changed`. */
    get(displayId: number): Promise<WallpaperInfo | null>
  }

  /** Phase 10: the countdown timer. */
  timer: {
    /**
     * A countdown reached zero: main shows the Windows notification unless Settings turn it off;
     * one per countdown (`endsAt`). Resolves true when one was shown.
     */
    notify(request: TimerNotifyRequest): Promise<boolean>
  }

  /** Native menus (Phase 3): the real Windows desktop menu, shown by main's helper process. */
  shellMenu: {
    /**
     * Shows the native Desktop background menu at the point and answers what became of it;
     * `fallback` means: open Taskyard's own menu there instead. Never rejects for a helper
     * failure (only for a malformed request).
     */
    show(request: ShellMenuShowRequest): Promise<ShellMenuShowResult>
    /** Whether native menus can show this session (else open Taskyard's menus at once). */
    available(): Promise<boolean>
  }

  /** Subscribes to a main → renderer event; returns the unsubscribe. */
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
}

declare global {
  interface Window {
    taskyard: TaskyardApi
  }
}
