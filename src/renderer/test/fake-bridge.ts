import { vi, type Mock } from 'vitest'
import { defaultSettings, emptyLayout, emptyTasks } from '@shared/defaults'
import type { DesktopItem } from '@shared/schema'
import type {
  DesktopIcon,
  DisplayInfo,
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
import type { TaskyardApi } from '../../preload/api'

type Listener = (payload: never) => void
type Api = TaskyardApi
/** Keeps the real (possibly generic) call signature; vitest's Mock<F> alone would flatten it. */
type Mocked<F extends (...args: never[]) => unknown> = F & Mock<F>

/**
 * A `window.taskyard` stand-in: every method is a mock, storage behaves like main's revision
 * protocol (without broadcasting), and `emit` plays main → renderer events.
 */
export interface FakeBridge extends TaskyardApi {
  storage: {
    load: Mocked<Api['storage']['load']>
    save: Mocked<Api['storage']['save']>
    status: Mocked<Api['storage']['status']>
  }
  app: {
    quit: Mocked<Api['app']['quit']>
    openExternal: Mocked<Api['app']['openExternal']>
  }
  display: {
    get: Mocked<Api['display']['get']>
    list: Mocked<Api['display']['list']>
  }
  desktop: { [K in keyof Api['desktop']]: Mocked<Api['desktop'][K]> }
  theme: { get: Mocked<Api['theme']['get']> }
  wallpaper: { get: Mocked<Api['wallpaper']['get']> }
  on: Mocked<Api['on']>
  emit<E extends IpcEventName>(event: E, payload: IpcEvents[E]): void
  listenerCount(event: IpcEventName): number
}

export interface FakeBridgeOptions {
  /** What `storage.load` returns per store; defaults for the rest. */
  files?: Partial<StoreFiles>
  /** Starting revision per store (1 when omitted). */
  revisions?: Partial<Record<StoreName, number>>
  status?: StorageStatus
  /** What `desktop.list` answers (empty when omitted). */
  items?: DesktopItem[]
  /** What `desktop.icons` answers (none when omitted). */
  icons?: DesktopIcon[]
}

const PRIMARY: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1392 },
  scaleFactor: 1.5
}

/** Windows in dark mode with transparency effects on. */
export const FAKE_THEME: ThemeInfo = {
  shouldUseDarkColors: true,
  prefersReducedTransparency: false
}

/** Main's first wallpaper version for a display (not the schema version). */
const FIRST_WALLPAPER_VERSION = 1

/** The primary display (2560×1440 px at 150 %) showing a letterboxed picture. */
export const FAKE_WALLPAPER: WallpaperInfo = {
  displayId: 1,
  version: FIRST_WALLPAPER_VERSION,
  url: 'taskyard://wallpaper/1?v=1',
  position: 'fit',
  color: '#000000',
  scaleFactor: 1.5,
  displayRectPx: { x: 0, y: 0, width: 2560, height: 1440 },
  virtualRectPx: { x: 0, y: 0, width: 2560, height: 1440 },
  hint: null
}

export function createFakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const listeners = new Map<IpcEventName, Set<Listener>>()
  const files: Record<StoreName, unknown> = {
    settings: defaultSettings(),
    layout: emptyLayout(),
    tasks: emptyTasks(),
    ...options.files
  }
  const revisions: Record<StoreName, number> = {
    settings: 1,
    layout: 1,
    tasks: 1,
    ...options.revisions
  }
  const status: StorageStatus = options.status ?? { readOnly: [], recovered: [] }

  const load = vi.fn(
    async (store: StoreName): Promise<StoreSnapshot> =>
      ({ revision: revisions[store], data: structuredClone(files[store]) }) as StoreSnapshot
  )
  const save = vi.fn(
    async (store: StoreName, request: SaveRequest<unknown>): Promise<SaveResult> => {
      if (request.baseRevision !== revisions[store]) {
        return {
          ok: false,
          reason: 'stale',
          revision: revisions[store],
          data: structuredClone(files[store])
        } as SaveResult
      }
      files[store] = structuredClone(request.data)
      revisions[store] += 1
      return { ok: true, revision: revisions[store] }
    }
  )
  const on = vi.fn((event: IpcEventName, listener: Listener) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(listener)
    return () => {
      listeners.get(event)?.delete(listener)
    }
  })

  return {
    versions: { electron: '44.4.5', chrome: '150.0.0.0', node: '24.0.0' },
    storage: {
      load: load as unknown as FakeBridge['storage']['load'],
      save: save as unknown as FakeBridge['storage']['save'],
      status: vi.fn(async () => structuredClone(status)) as FakeBridge['storage']['status']
    },
    app: {
      quit: vi.fn(async () => {}) as FakeBridge['app']['quit'],
      openExternal: vi.fn(async () => {}) as FakeBridge['app']['openExternal']
    },
    display: {
      get: vi.fn(async () => PRIMARY) as FakeBridge['display']['get'],
      list: vi.fn(async () => [PRIMARY]) as FakeBridge['display']['list']
    },
    desktop: {
      list: vi.fn(async () => structuredClone(options.items ?? [])),
      open: vi.fn(async () => ({ ok: true as const })),
      showInFolder: vi.fn(async () => ({ ok: true as const })),
      rename: vi.fn(async () => ({ ok: true as const, path: '' })),
      trash: vi.fn(async () => ({ ok: true as const })),
      moveToDesktop: vi.fn(async () => ({ moves: [] })),
      undoMove: vi.fn(async () => ({ ok: true as const, path: '' })),
      rescan: vi.fn(async () => {}),
      icons: vi.fn(async () => structuredClone(options.icons ?? []))
    } as unknown as FakeBridge['desktop'],
    theme: {
      get: vi.fn(async () => ({ ...FAKE_THEME })) as FakeBridge['theme']['get']
    },
    wallpaper: {
      get: vi.fn(async (displayId: number) =>
        displayId === FAKE_WALLPAPER.displayId ? structuredClone(FAKE_WALLPAPER) : null
      ) as FakeBridge['wallpaper']['get']
    },
    on: on as unknown as FakeBridge['on'],
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) (listener as (p: unknown) => void)(payload)
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0
    }
  }
}

/** Puts a fake bridge on `window.taskyard`; setupTests removes it after each test. */
export function installFakeBridge(bridge: FakeBridge = createFakeBridge()): FakeBridge {
  window.taskyard = bridge
  return bridge
}
