import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { DesktopChange, DesktopIcon, IpcEvents, SaveResultOf } from '@shared/ipc'
import { replaceItemId } from '@shared/layout-ids'
import { renamePath } from '@shared/layout-mutations'
import type { LayoutFile } from '@shared/schema'
import type { OpsJournal } from '../storage/ops-journal'
import type { Win32Api } from '../win32/api'
import { startChokidar, type FsWatch, type StartWatching } from './chokidar-source'
import type { DesktopIpcTarget } from './desktop-ipc'
import type { Env } from './env-vars'
import { createFileOps, type FileOpsShell } from './file-ops'
import { DesktopModel, pathKey } from './model'
import {
  describeScan,
  readDesktopItem,
  scanDesktop,
  type ScanFolder,
  type ScanReport
} from './scanner'
import { readShortcut, type ShortcutDetails } from './shortcuts'
import { DesktopTracker, type TrackerSink } from './watcher'

export interface DesktopLog {
  info(message: string): void
  warn(message: string, ...details: unknown[]): void
  error(message: string, ...details: unknown[]): void
}

/** The icon pipeline (Phase 5): told every change and rename, asked for the icons sent so far. */
export interface DesktopIcons {
  update(change: DesktopChange): void
  renamed(id: string, path: string): void
  list(): DesktopIcon[]
}

export interface DesktopServiceDeps {
  /** resolveDesktopDirs(): the user Desktop first, then the Public Desktop. */
  dirs: readonly string[]
  win32: Pick<Win32Api, 'getFileAttributes' | 'canModifyFolder' | 'moveFile' | 'setHidden'>
  shell: FileOpsShell & { readShortcutLink?: (path: string) => ShortcutDetails }
  journal: Pick<OpsJournal, 'begin' | 'advance' | 'get'>
  /** Main's layout store: renames update `paths` through it (revision bump + storage:changed). */
  layout: { get(): LayoutFile; save(data: LayoutFile): SaveResultOf<LayoutFile> }
  emit: <E extends 'desktop:changed' | 'desktop:renamed'>(
    event: E,
    payload: IpcEvents[E]
  ) => unknown
  env: Env
  log: DesktopLog
  startWatching?: StartWatching
  /** Phase 5: the icon service (see icon-service.ts). */
  icons?: DesktopIcons
}

export interface DesktopService extends DesktopIpcTarget {
  /** Boot step "scan": the full list (also emitted as desktop:changed) and the log line. */
  scan(): Promise<ScanReport>
  /** Boot step "watch": starts the file watcher (a no-op after `stop`). */
  watch(): Promise<void>
  /** Phase 8 drag-out: the current paths of the ids main knows, in order (others skipped). */
  pathsOf(ids: readonly string[]): string[]
  /** Quit path: stops the watcher and every pending timer. Safe to call twice. */
  stop(): Promise<void>
}

/**
 * Main's desktop: the boot scan, the watcher, `desktop:list` and the file operations over one
 * model. Renames — Taskyard's or Explorer's — keep the item's id (so its placement), emit
 * `desktop:renamed`, and update the layout's top-level `paths[id]` through main's own layout
 * store, once. Renderers never write paths on rename.
 */
export function createDesktopService(deps: DesktopServiceDeps): DesktopService {
  const { dirs, log } = deps
  // Every change and rename also goes to the icon pipeline (Phase 5).
  const emitChanged = (change: DesktopChange): void => {
    deps.emit('desktop:changed', change)
    deps.icons?.update(change)
  }
  const emitRenamed = (id: string, path: string): void => {
    deps.emit('desktop:renamed', { id, path })
    deps.icons?.renamed(id, path)
  }
  const model = new DesktopModel()
  let folderStates: ScanFolder[] | null = null
  let watching: FsWatch | null = null
  let stopped = false
  let markScanned: () => void = () => {}
  const scanned = new Promise<void>((resolve) => (markScanned = resolve))

  const scanDeps = {
    win32: deps.win32,
    readShortcut: (path: string, kind: 'link' | 'url') =>
      readShortcut(path, kind, {
        readFile: (file) => readFile(file),
        readShortcutLink: deps.shell.readShortcutLink,
        env: deps.env,
        log
      }),
    log
  }

  /** The folders as last scanned (checked on demand before the first scan). */
  const folders = (): ScanFolder[] =>
    folderStates ?? dirs.map((path) => ({ path, readonly: !deps.win32.canModifyFolder(path) }))
  const folderOf = (path: string): ScanFolder => {
    const key = pathKey(path)
    return folders().find((folder) => key.startsWith(`${pathKey(folder.path)}\\`)) ?? folders()[0]
  }

  const updateLayout = (change: (layout: LayoutFile) => LayoutFile, what: string): void => {
    try {
      const current = deps.layout.get()
      const next = change(current)
      if (next === current) return
      const result = deps.layout.save(next)
      if (!result.ok) log.warn(`desktop: layout is ${result.reason}; ${what} not saved`)
    } catch (error) {
      log.error(`desktop: saving ${what} failed`, error)
    }
  }

  const sink: TrackerSink = {
    changed: emitChanged,
    renamed: (id, path) => {
      emitRenamed(id, path)
      updateLayout((layout) => renamePath(layout, id, path), `the new path of ${id}`)
    },
    pathsMoved: (moves) =>
      updateLayout(
        (layout) => [...moves].reduce((next, [id, path]) => renamePath(next, id, path), layout),
        'moved paths'
      ),
    replaced: (oldId, newId) =>
      updateLayout((layout) => replaceItemId(layout, oldId, newId), `the new id of ${oldId}`)
  }

  const runScan = async (): Promise<ScanReport> => {
    const report = await scanDesktop(dirs, scanDeps)
    folderStates = report.folders.map(({ path, readonly }) => ({ path, readonly }))
    for (const folder of report.folders) {
      log.info(
        `scan: folder ${folder.path} ${folder.readonly ? 'read-only' : 'writable'}, ${folder.count} item(s)`
      )
    }
    log.info(describeScan(report))
    return report
  }

  const tracker = new DesktopTracker({
    model,
    dirs,
    readItem: (path) => readDesktopItem(path, folderOf(path), scanDeps),
    idAt: async (path) => {
      try {
        const stats = statSync(path, { bigint: true })
        return `${stats.dev}:${stats.ino}`
      } catch {
        return null
      }
    },
    scan: async () => (await runScan()).items,
    sink,
    log
  })

  const ops = createFileOps({
    model,
    tracker,
    folders,
    win32: deps.win32,
    shell: deps.shell,
    journal: deps.journal,
    log
  })

  return {
    ...ops,

    async scan() {
      let report: ScanReport
      try {
        report = await runScan()
      } catch (error) {
        markScanned() // desktop:list answers (empty) rather than hang
        throw error
      }
      // Files renamed while Taskyard was closed: their placement follows the id; the path too.
      const known = deps.layout.get().paths
      const moves = new Map(
        report.items
          .filter((item) => known[item.id] !== undefined && known[item.id] !== item.path)
          .map((item) => [item.id, item.path])
      )
      if (moves.size > 0) sink.pathsMoved(moves)
      model.replaceAll(report.items)
      markScanned()
      emitChanged({ added: report.items, removed: [], changed: [] })
      return report
    },

    async list() {
      await scanned
      return model.list()
    },

    rescan: () => tracker.rescan(),

    icons: () => deps.icons?.list() ?? [],

    pathsOf: (ids) =>
      ids.map((id) => model.get(id)?.path).filter((path): path is string => path !== undefined),

    async watch() {
      if (stopped || watching !== null) return
      const started = await (deps.startWatching ?? startChokidar)(
        dirs,
        (type, path) => tracker.handle(type, path),
        (error) => log.warn('desktop: the file watcher reported an error', error)
      )
      if (stopped) {
        await started.close()
        return
      }
      watching = started
      log.info(`desktop: watching ${dirs.length} folder(s)`)
    },

    async stop() {
      stopped = true
      tracker.dispose()
      const current = watching
      watching = null
      await current?.close()
    }
  }
}
