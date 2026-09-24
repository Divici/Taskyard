// The typed contract between main, the sandboxed preload and the renderer.
// Types and plain constants only: the preload bundles this file, so it must never import zod
// (inbound validation lives in src/main/ipc/handlers.ts).
import type { DesktopItem, LayoutFile, Rect, SettingsFile, TasksFile } from './schema'

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
  /** Physical pixel size of the square icon. */
  px: number
  dataUrl: string
}

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
  display: { get: 'display:get', list: 'display:list' }
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
}

export type RequestChannel = keyof IpcRequests

/**
 * Channels later phases implement, declared so their shapes are visible now. Not exposed by the
 * preload and not handled until the owning phase adds them; that phase finalises the result types.
 */
export interface PlannedRequests {
  /** Phase 4 */
  'desktop:list': { args: []; result: DesktopItem[] }
  'desktop:open': { args: [id: string]; result: void }
  'desktop:showInFolder': { args: [id: string]; result: void }
  'desktop:rename': { args: [id: string, newName: string]; result: unknown }
  'desktop:trash': { args: [id: string]; result: void }
  'desktop:moveToDesktop': { args: [paths: string[]]; result: unknown }
  'desktop:undoMove': { args: [token: string]; result: void }
  'desktop:rescan': { args: []; result: void }
  /** Phase 8 */
  'desktop:startDrag': { args: [ids: string[]]; result: void }
  /** Phase 10 */
  'timer:notify': { args: [linkedTaskText?: string]; result: void }
}
