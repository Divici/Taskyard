import { win32 } from 'node:path'
import type { DesktopChange } from '@shared/ipc'
import { splitItemName } from '@shared/item-name'
import type { DesktopItem } from '@shared/schema'
import { pathKey, sameItem, type DesktopModel } from './model'

/** An unlink waits this long for an add of the same file id: together they are a rename. */
export const RENAME_WINDOW_MS = 500
/** Changes are sent 150 ms after the last one (a storm becomes one desktop:changed)… */
export const CHANGE_DEBOUNCE_MS = 150
/** …but never later than this after the first, so a storm that never pauses is still seen. */
export const CHANGE_MAX_WAIT_MS = 1_000

export type FsEventType = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'

/** Where the tracker's conclusions go (desktop-service.ts: IPC events and the layout). */
export interface TrackerSink {
  /** Batched adds, removals and changes (desktop:changed). */
  changed(change: DesktopChange): void
  /** A file kept its id and moved to `path` (desktop:renamed + the layout's `paths[id]`). */
  renamed(id: string, path: string): void
  /** A full rescan found known ids at new paths (the layout's `paths` only). */
  pathsMoved(moves: Map<string, string>): void
  /** A path now holds a new file id (an atomic save): the layout re-keys `oldId` → `newId`. */
  replaced(oldId: string, newId: string): void
}

export interface TrackerDeps {
  model: DesktopModel
  /** The desktop folders; only their direct children are items. */
  dirs: readonly string[]
  /** scanner.ts `readDesktopItem` for the folder holding `path` (null = not an item). */
  readItem: (path: string) => Promise<DesktopItem | null>
  /** The file id at `path` right now, or null when nothing is there. */
  idAt: (path: string) => Promise<string | null>
  /** A full scan (desktop:rescan). */
  scan: () => Promise<DesktopItem[]>
  sink: TrackerSink
  log: {
    warn(message: string, ...details: unknown[]): void
    error(message: string, ...details: unknown[]): void
  }
}

type Entry = { kind: 'added' | 'changed'; item: DesktopItem } | { kind: 'removed' }

/** Pending desktop:changed, one entry per id, coalesced as events arrive. */
class ChangeBatch {
  private readonly entries = new Map<string, Entry>()

  get empty(): boolean {
    return this.entries.size === 0
  }
  present(item: DesktopItem, isNew: boolean): void {
    const previous = this.entries.get(item.id)
    let kind: 'added' | 'changed' = isNew ? 'added' : 'changed'
    if (previous?.kind === 'added') kind = 'added'
    else if (previous?.kind === 'removed') kind = 'changed' // gone and back within one batch
    this.entries.set(item.id, { kind, item })
  }
  remove(id: string): void {
    // Added and removed before anyone heard of it: nothing to say.
    if (this.entries.get(id)?.kind === 'added') this.entries.delete(id)
    else this.entries.set(id, { kind: 'removed' })
  }
  take(): DesktopChange {
    const change: DesktopChange = { added: [], removed: [], changed: [] }
    for (const [id, entry] of this.entries) {
      if (entry.kind === 'removed') change.removed.push(id)
      else change[entry.kind].push(entry.item)
    }
    this.entries.clear()
    return change
  }
  clear(): void {
    this.entries.clear()
  }
}

/** Same file apart from where it lives (path, and the name/extension derived from it). */
function sameExceptPath(before: DesktopItem, after: DesktopItem): boolean {
  return sameItem({ ...before, path: after.path, name: after.name, ext: after.ext }, after)
}

/**
 * Keeps the model in step with the desktop folders from file-system events (chokidar, see
 * chokidar-source.ts) and from Taskyard's own file operations. Events are processed one at a
 * time, in order. A path's id comes from the model (an unlinked path can no longer be
 * stat'ed): an unlink is held for 500 ms, and an add of the same id meanwhile — or before it —
 * is a rename (`desktop:renamed`, never removed + added, so the placement stays). Adds, removals
 * and changes are batched (150 ms debounce, 1 s at most).
 */
export class DesktopTracker {
  private queue: Promise<void> = Promise.resolve()
  private readonly pendingUnlinks = new Map<
    string,
    { path: string; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly batch = new ChangeBatch()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private batchStartedAt: number | null = null
  private disposed = false
  private readonly dirKeys: Set<string>
  private readonly warnedDuplicates = new Set<string>()

  constructor(private readonly deps: TrackerDeps) {
    this.dirKeys = new Set(deps.dirs.map((dir) => pathKey(win32.resolve(dir))))
  }

  /** A file-system event (chokidar's name for it and the absolute path). */
  handle(type: FsEventType, path: string): void {
    if (this.disposed || !this.isDesktopChild(path)) return
    void this.enqueue(() =>
      type === 'unlink' || type === 'unlinkDir' ? this.onGone(path) : this.onPresent(path)
    )
  }

  /** Resolves once every event handed in so far has been processed. */
  idle(): Promise<void> {
    return this.queue
  }

  /** desktop:rescan: sends what is batched, then the full list (every item added, vanished ids removed). */
  rescan(): Promise<void> {
    return this.enqueue(async () => {
      this.flush()
      this.cancelAllUnlinks()
      const items = await this.deps.scan()
      if (this.disposed) return
      const previous = new Map(this.deps.model.list().map((item) => [item.id, item]))
      const present = new Set(items.map((item) => item.id))
      const moves = new Map<string, string>()
      for (const item of items) {
        const before = previous.get(item.id)
        if (before && before.path !== item.path) moves.set(item.id, item.path)
      }
      this.deps.model.replaceAll(items)
      if (moves.size > 0) this.deps.sink.pathsMoved(moves)
      this.deps.sink.changed({
        added: items,
        removed: [...previous.keys()].filter((id) => !present.has(id)),
        changed: []
      })
    })
  }

  /** Taskyard renamed `id` to `path` (file-ops): reported once; the watcher's echo is a no-op. */
  applyRenamed(id: string, path: string): Promise<void> {
    return this.enqueue(async () => {
      const existing = this.deps.model.get(id)
      if (!existing) return
      const item = (await this.deps.readItem(path)) ?? {
        ...existing,
        path,
        ...splitItemName(path, existing.kind)
      }
      this.cancelUnlink(id)
      this.moveTo(existing, item)
    })
  }

  /** Taskyard trashed or moved away `id`: reported right away. */
  applyRemoved(id: string): Promise<void> {
    return this.enqueue(async () => {
      this.cancelUnlink(id)
      if (this.deps.model.remove(id)) this.batch.remove(id)
      this.flush()
    })
  }

  /** Taskyard moved a file onto the desktop: added (and reported) right away; null if not an item. */
  applyPresent(path: string): Promise<DesktopItem | null> {
    return this.enqueue(async () => {
      const item = await this.deps.readItem(path)
      if (item === null) return null
      this.record(item)
      this.flush()
      return item
    }).then((item) => item ?? null)
  }

  /** Sends the batch now. */
  flush(): void {
    this.clearFlushTimer()
    this.batchStartedAt = null
    if (this.batch.empty) return
    this.deps.sink.changed(this.batch.take())
  }

  dispose(): void {
    this.disposed = true
    this.cancelAllUnlinks()
    this.clearFlushTimer()
    this.batch.clear()
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T | undefined> {
    const run = this.queue.then(() => (this.disposed ? undefined : task()))
    this.queue = run.then(
      () => {},
      (error: unknown) => this.deps.log.error('desktop: processing a desktop change failed', error)
    )
    return run
  }

  private isDesktopChild(path: string): boolean {
    return this.dirKeys.has(pathKey(win32.dirname(win32.resolve(path))))
  }

  private async onGone(path: string): Promise<void> {
    const id = this.deps.model.idAt(path)
    if (id === undefined || this.pendingUnlinks.has(id)) return
    const timer = setTimeout(() => {
      void this.enqueue(async () => this.expireUnlink(id, path))
    }, RENAME_WINDOW_MS)
    this.pendingUnlinks.set(id, { path, timer })
  }

  private expireUnlink(id: string, path: string): void {
    const pending = this.pendingUnlinks.get(id)
    if (!pending || pending.path !== path) return
    this.pendingUnlinks.delete(id)
    const current = this.deps.model.get(id)
    if (!current || pathKey(current.path) !== pathKey(path)) return
    this.deps.model.remove(id)
    this.batch.remove(id)
    this.schedule()
  }

  private async onPresent(path: string): Promise<void> {
    const item = await this.deps.readItem(path)
    const { model } = this.deps
    const knownId = model.idAt(path)

    if (item === null) {
      if (knownId === undefined) return
      // Gone after all (the unlink will follow), or still there but hidden now.
      if ((await this.deps.idAt(path)) === null) return this.onGone(path)
      this.cancelUnlink(knownId)
      model.remove(knownId)
      this.batch.remove(knownId)
      this.schedule()
      return
    }

    if (knownId === item.id) {
      this.cancelUnlink(item.id)
      const existing = model.get(item.id)!
      // Same key, other spelling: a case-only rename.
      if (existing.path !== item.path) this.moveTo(existing, item)
      else this.record(item)
      return
    }

    if (knownId !== undefined) {
      // The path holds a different file now (written elsewhere and renamed over it).
      this.cancelUnlink(knownId)
      model.remove(knownId)
      this.batch.remove(knownId)
      if (!model.get(item.id)) {
        this.deps.sink.replaced(knownId, item.id)
        this.record(item)
        return
      }
    }

    const existing = model.get(item.id)
    if (existing) {
      const pending = this.pendingUnlinks.get(item.id)
      if (!pending && (await this.deps.idAt(existing.path)) === item.id) {
        // One file under two names (a hard link): the item stays at its first path.
        if (!this.warnedDuplicates.has(item.id)) {
          this.warnedDuplicates.add(item.id)
          this.deps.log.warn(
            `desktop: ${path} is the same file as ${existing.path}; not shown twice`
          )
        }
        return
      }
      this.cancelUnlink(item.id)
      this.moveTo(existing, item)
      return
    }

    this.record(item)
  }

  /** Puts a present item into the model and the batch (added, or changed if it differs). */
  private record(item: DesktopItem): void {
    const current = this.deps.model.get(item.id)
    if (current && sameItem(current, item)) return
    this.deps.model.put(item)
    this.batch.present(item, current === undefined)
    this.schedule()
  }

  private moveTo(existing: DesktopItem, item: DesktopItem): void {
    // Whatever is batched goes first, so a renderer never renames an item it has not seen.
    this.flush()
    this.deps.model.put(item)
    if (existing.path !== item.path) this.deps.sink.renamed(item.id, item.path)
    if (!sameExceptPath(existing, item)) {
      this.batch.present(item, false)
      this.schedule()
    }
  }

  private schedule(): void {
    if (this.batch.empty || this.disposed) return
    const now = Date.now()
    if (this.batchStartedAt === null) this.batchStartedAt = now
    this.clearFlushTimer()
    const wait = Math.min(CHANGE_DEBOUNCE_MS, this.batchStartedAt + CHANGE_MAX_WAIT_MS - now)
    this.flushTimer = setTimeout(() => this.flush(), Math.max(0, wait))
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  private cancelUnlink(id: string): void {
    const pending = this.pendingUnlinks.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingUnlinks.delete(id)
  }

  private cancelAllUnlinks(): void {
    for (const { timer } of this.pendingUnlinks.values()) clearTimeout(timer)
    this.pendingUnlinks.clear()
  }
}
