// The typed contract between main, the sandboxed preload and the renderer.
// Types and plain constants only: the preload bundles this file, so it must never import zod
// (inbound validation lives in src/main/ipc/handlers.ts).
import type { DesktopItem, LayoutFile, Rect, SettingsFile, TasksFile } from './schema'
import type { PxRect, WallpaperPosition } from './wallpaper-geometry'

// ---------------------------------------------------------------------------------------------
// Storage

/** Files the renderer owns and persists through `storage:save`. */
export const STORE_NAMES = ['settings', 'layout', 'tasks'] as const
export type StoreName = (typeof STORE_NAMES)[number]

/** Every data file in userData, including main's move journal. */
export type DataFileName = StoreName | 'ops'

export interface StoreFiles {
  settings: SettingsFile
  layout: LayoutFile
  tasks: TasksFile
}

// Optimistic concurrency: main keeps a revision per store (1 after load, +1 per accepted save).
// Every save names the revision it was built on; main accepts it only if that is still current,
// so two windows can never overwrite each other's changes unseen.

/** A store's full data at one revision. */
export interface Snapshot<T> {
  revision: number
  data: T
}

export type StoreSnapshot<N extends StoreName = StoreName> = Snapshot<StoreFiles[N]>

export interface SaveRequest<T> {
  /** The revision the data was built on. */
  baseRevision: number
  data: T
}

export type SaveResultOf<T> =
  /** Accepted: the data is now `revision` (and is broadcast to every window). */
  | { ok: true; revision: number }
  /** `baseRevision` is old: nothing changed; rebase onto this revision and data, then retry. */
  | { ok: false; reason: 'stale'; revision: number; data: T }
  /** The file is from a newer Taskyard (or unreadable) and is never written this session. */
  | { ok: false; reason: 'read-only' }

export type SaveResult<N extends StoreName = StoreName> = SaveResultOf<StoreFiles[N]>

/** A file that failed to load: quarantined as `<name>.corrupt-<iso>.json`, then replaced. */
export interface StorageRecovered {
  store: DataFileName
  restoredFrom: 'backup' | 'defaults'
  reason: 'unreadable-json' | 'invalid' | 'migration-failed'
  /** Absolute path of the quarantined copy. */
  corruptPath: string
}

/** A file Taskyard will not overwrite this session. */
export interface ReadOnlyInfo {
  store: DataFileName
  reason: 'future-version' | 'read-error'
  /** The file's `version` when it is newer than this build understands. */
  version?: number
}

export interface StorageStatus {
  readOnly: ReadOnlyInfo[]
  recovered: StorageRecovered[]
}

/**
 * A store changed (any window's save, or main itself); sent to every window, the saving one
 * included. The payload is the full new file at `revision`.
 */
export type StorageChanged = {
  [N in StoreName]: { store: N; revision: number; data: StoreFiles[N] }
}[StoreName]

// ---------------------------------------------------------------------------------------------
// Displays (handlers registered by the desktop window manager: src/main/windows/display-ipc.ts)

export interface DisplayInfo {
  /** Electron `Display.id`. */
  id: number
  bounds: Rect
  workArea: Rect
  scaleFactor: number
}

// ---------------------------------------------------------------------------------------------
// Event payloads (main → renderer)

export interface DesktopChange {
  added: DesktopItem[]
  /** File ids no longer on the desktop. */
  removed: string[]
  changed: DesktopItem[]
}

export interface DesktopRenamed {
  id: string
  path: string
}

export interface DesktopIcon {
  id: string
  /** Physical pixel size of the square icon (0 with a null dataUrl). */
  px: number
  /** A PNG data URL, or null: the item has no icon any more; show the generic one. */
  dataUrl: string | null
  /**
   * Which version of the item's icon this is (its file, source and plan). A different version
   * replaces the current icon whatever its size; the same version only ever gets sharper.
   */
  version: string
}

// ---------------------------------------------------------------------------------------------
// Desktop file operations (Phase 4). Failures are typed results, never thrown across IPC (an
// Error thrown in main reaches the renderer as a bare message, without its code).

export const DESKTOP_ERROR_CODES = [
  /** The id is not on the desktop (any more), or the file is gone (ENOENT). */
  'not-found',
  /** The item is in a folder Windows will not let this user change (Public Desktop). */
  'readonly',
  /** A file with that name exists (EEXIST); nothing was replaced. */
  'exists',
  /** Windows refused (EPERM / EACCES). */
  'permission',
  /** The file is in use by another app (EBUSY). */
  'busy',
  /** Longer than 255 characters (or ENAMETOOLONG from Windows). */
  'name-too-long',
  /** Empty, reserved (CON, NUL…), a forbidden character, or a trailing dot or space. */
  'invalid-name',
  /** A cross-volume copy did not match its source; the source was kept. */
  'hash-mismatch',
  /** ops.json is from a newer Taskyard, so no move can be journaled. */
  'journal-read-only',
  /** Anything else; `message` says what. */
  'failed'
] as const
export type DesktopErrorCode = (typeof DESKTOP_ERROR_CODES)[number]

export interface DesktopFailure {
  ok: false
  code: DesktopErrorCode
  /** Technical detail (logs, toast descriptions); the renderer words the message by `code`. */
  message: string
}

export type DesktopActionResult = { ok: true } | DesktopFailure
/** `path` is the item's new path; its id is unchanged. */
export type RenameResult = { ok: true; path: string } | DesktopFailure
/**
 * One dropped path. `token` identifies the journaled move for `desktop:undoMove`; it is null when
 * the path was already on a desktop (nothing moved).
 */
export type MoveOutcome =
  | { from: string; ok: true; id: string; path: string; token: string | null }
  | ({ from: string } & DesktopFailure)
export interface MoveToDesktopResult {
  /** One outcome per requested path, in order. */
  moves: MoveOutcome[]
}
/** `path` is where the file is back. */
export type UndoMoveResult = { ok: true; path: string } | DesktopFailure

export interface ThemeInfo {
  shouldUseDarkColors: boolean
  prefersReducedTransparency: boolean
}

export interface PeekState {
  peeking: boolean
}

export interface WallpaperChanged {
  displayId: number
  /** Cache-busting counter for `taskyard://wallpaper/<displayId>?v=<n>`. */
  version: number
}

/**
 * Why a display does not show the picture Windows was asked to show (for the settings hint):
 * - `solid-color`: Windows has no picture on this display; its desktop colour is painted.
 * - `transcoded`: the picture cannot be shown (undecodable, e.g. HDR `.jxr`, or missing), so
 *   Windows' own converted copy (`Themes\Transcoded_00N`) is shown instead.
 * - `color-fallback`: the picture cannot be shown and there is no usable copy: colour only.
 * - `unavailable`: Taskyard could not read the Windows wallpaper at all: colour only.
 */
export type WallpaperHint = 'solid-color' | 'transcoded' | 'color-fallback' | 'unavailable'

/** What one display's wallpaper layer paints (`wallpaper:get`; refetched on `wallpaper:changed`). */
export interface WallpaperInfo {
  displayId: number
  /** Bumped whenever anything below changes. */
  version: number
  /** `taskyard://wallpaper/<displayId>?v=<version>`, or null: paint `color` only. */
  url: string | null
  position: WallpaperPosition
  /** The desktop background colour (`#rrggbb`), painted under the picture (fit/center bars). */
  color: string
  scaleFactor: number
  /** This display and the whole virtual screen, in physical pixels (Windows' layout unit). */
  displayRectPx: PxRect
  virtualRectPx: PxRect
  hint: WallpaperHint | null
}

export interface IpcEvents {
  'desktop:changed': DesktopChange
  'desktop:renamed': DesktopRenamed
  'desktop:icon': DesktopIcon
  'storage:recovered': StorageRecovered
  'storage:changed': StorageChanged
  'theme:changed': ThemeInfo
  'peek:changed': PeekState
  'display:changed': DisplayInfo
  'wallpaper:changed': WallpaperChanged
}

export type IpcEventName = keyof IpcEvents

export const EVENT_CHANNELS = [
  'desktop:changed',
  'desktop:renamed',
  'desktop:icon',
  'storage:recovered',
  'storage:changed',
  'theme:changed',
  'peek:changed',
  'display:changed',
  'wallpaper:changed'
] as const satisfies readonly IpcEventName[]

// Compile-time proof that EVENT_CHANNELS lists every key of IpcEvents.
type MissingEvents = Exclude<IpcEventName, (typeof EVENT_CHANNELS)[number]>
const everyEventListed: MissingEvents extends never ? true : MissingEvents = true
void everyEventListed

export function isEventChannel(value: unknown): value is IpcEventName {
  return typeof value === 'string' && (EVENT_CHANNELS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------------------------
// Requests (renderer → main, `ipcRenderer.invoke`)

export const IPC = {
  storage: { load: 'storage:load', save: 'storage:save', status: 'storage:status' },
  app: { quit: 'app:quit', openExternal: 'app:openExternal' },
  display: { get: 'display:get', list: 'display:list' },
  desktop: {
    list: 'desktop:list',
    open: 'desktop:open',
    showInFolder: 'desktop:showInFolder',
    rename: 'desktop:rename',
    trash: 'desktop:trash',
    moveToDesktop: 'desktop:moveToDesktop',
    undoMove: 'desktop:undoMove',
    rescan: 'desktop:rescan',
    // Phase 5
    icons: 'desktop:icons'
  },
  theme: { get: 'theme:get' },
  wallpaper: { get: 'wallpaper:get' }
} as const

/** `app:openExternal` opens only these URL schemes; main enforces it. */
export const EXTERNAL_URL_PROTOCOLS = ['ms-settings:', 'https:'] as const

export interface IpcRequests {
  'storage:load': { args: [store: StoreName]; result: StoreSnapshot }
  'storage:save': {
    args: [store: StoreName, request: SaveRequest<StoreFiles[StoreName]>]
    result: SaveResult
  }
  'storage:status': { args: []; result: StorageStatus }
  'app:quit': { args: []; result: void }
  'app:openExternal': { args: [url: string]; result: void }
  /** null when main knows no display with that id (e.g. it was just unplugged). */
  'display:get': { args: [id: number]; result: DisplayInfo | null }
  'display:list': { args: []; result: DisplayInfo[] }
  /** Every desktop item main knows (waits for the boot scan). */
  'desktop:list': { args: []; result: DesktopItem[] }
  /** `.url` → its URL in the browser; everything else → its default app (shell.openPath). */
  'desktop:open': { args: [id: string]; result: DesktopActionResult }
  'desktop:showInFolder': { args: [id: string]; result: DesktopActionResult }
  /** `newName` is the new file name (with extension), not a path. Never replaces a file. */
  'desktop:rename': { args: [id: string, newName: string]; result: RenameResult }
  /** To the Recycle Bin. */
  'desktop:trash': { args: [id: string]; result: DesktopActionResult }
  /** Absolute paths (Explorer drop) moved into the user's Desktop, journaled, hash-verified. */
  'desktop:moveToDesktop': { args: [paths: string[]]; result: MoveToDesktopResult }
  'desktop:undoMove': { args: [token: string]; result: UndoMoveResult }
  /** Scans again and re-emits the full list as desktop:changed. */
  'desktop:rescan': { args: []; result: void }
  /** The Windows app theme and transparency setting (then followed with theme:changed). */
  'theme:get': { args: []; result: ThemeInfo }
  /** The display's wallpaper; null when main knows no display with that id. */
  'wallpaper:get': { args: [displayId: number]; result: WallpaperInfo | null }
  /** Phase 5: the best icon main has sent so far for every item (a window that loads late). */
  'desktop:icons': { args: []; result: DesktopIcon[] }
}

export type RequestChannel = keyof IpcRequests

/**
 * Channels later phases implement, declared so their shapes are visible now. Not exposed by the
 * preload and not handled until the owning phase adds them; that phase finalises the result types.
 */
export interface PlannedRequests {
  /** Phase 8 */
  'desktop:startDrag': { args: [ids: string[]]; result: void }
  /** Phase 10 */
  'timer:notify': { args: [linkedTaskText?: string]; result: void }
}
