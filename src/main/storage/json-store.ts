import { copyFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import type { ReadOnlyInfo, SaveResultOf, Snapshot, StorageRecovered } from '@shared/ipc'
import { DEFAULT_RETRY_DELAYS_MS, errorCode, retrying } from './retry'
import {
  backupPathFor,
  loadVersionedFile,
  type StorageLog,
  type VersionedFileSpec
} from './versioned-file'

export const DEFAULT_DEBOUNCE_MS = 300

export interface JsonStoreOptions<T> extends VersionedFileSpec<T> {
  log: StorageLog
  debounceMs?: number
  now?: () => Date
  retryDelaysMs?: readonly number[]
  /** Called after every accepted save with the new revision (main broadcasts it). */
  onChange?: (snapshot: Snapshot<T>) => void
  /** Atomic write (temp file + rename); injectable for tests. */
  write?: (path: string, text: string) => Promise<void>
  writeSync?: (path: string, text: string) => void
}

export class InvalidStoreDataError extends Error {
  override name = 'InvalidStoreDataError'
}

function serialize(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

/**
 * One versioned JSON file in userData: load → parse → migrate → validate, then an in-memory copy
 * with a revision (1 after load, +1 per accepted save). `save` updates it — only if the caller's
 * base revision is still current — and writes debounced (300 ms) and atomically, keeping the
 * previous file as `<file>.bak`. `flush` writes anything pending now (before-quit awaits it).
 */
export class JsonStore<T> {
  readonly name: VersionedFileSpec<T>['name']
  readonly path: string

  private current: T
  private revision = 1
  private pending: Snapshot<T> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private chain: Promise<void> = Promise.resolve()
  private inFlight = 0
  /** Revision of the newest data a synchronous (session-end) write put on disk. */
  private syncWrittenRevision = 0
  private loadedReadOnly: ReadOnlyInfo | null = null
  private loadedRecovered: StorageRecovered | null = null
  private refusedWhileReadOnly = false

  private readonly debounceMs: number
  private readonly retryDelaysMs: readonly number[]
  private readonly write: (path: string, text: string) => Promise<void>
  private readonly writeSync: (path: string, text: string) => void

  constructor(private readonly options: JsonStoreOptions<T>) {
    this.name = options.name
    this.path = options.path
    this.current = options.defaults()
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.write = options.write ?? ((path, text) => writeFileAtomic(path, text, 'utf8'))
    this.writeSync = options.writeSync ?? ((path, text) => writeFileAtomic.sync(path, text, 'utf8'))
  }

  /** The current value: defaults until `load` resolves. */
  get(): T {
    return this.current
  }

  /** The current value with its revision, as `storage:load` serves it. */
  snapshot(): Snapshot<T> {
    return { revision: this.revision, data: this.current }
  }

  /** Set when the file is from a newer version or unreadable: `save` refuses, nothing is written. */
  get readOnly(): ReadOnlyInfo | null {
    return this.loadedReadOnly
  }

  /** Set when `load` found the file corrupt and replaced it. */
  get recovered(): StorageRecovered | null {
    return this.loadedRecovered
  }

  async load(): Promise<T> {
    const outcome = await loadVersionedFile(this.options, {
      log: this.options.log,
      now: this.options.now ?? (() => new Date()),
      retryDelaysMs: this.retryDelaysMs
    })
    this.current = outcome.data
    this.revision = 1
    this.loadedReadOnly = outcome.readOnly
    this.loadedRecovered = outcome.recovered
    return this.current
  }

  /**
   * Validates and keeps `data` as the next revision, then schedules a debounced write.
   * With `baseRevision` (a renderer's save) it is accepted only if that is still the current
   * revision; otherwise the reply is `stale` with the current data to rebase on. Main-side saves
   * omit it. Throws on invalid data.
   */
  save(data: T, baseRevision?: number): SaveResultOf<T> {
    if (this.loadedReadOnly) {
      if (!this.refusedWhileReadOnly) {
        this.refusedWhileReadOnly = true
        this.options.log.warn(`storage: ${this.name} is read-only; changes are not saved`)
      }
      return { ok: false, reason: 'read-only' }
    }

    const parsed = this.options.schema.safeParse(data)
    if (!parsed.success) {
      throw new InvalidStoreDataError(`invalid ${this.name} data: ${z.prettifyError(parsed.error)}`)
    }
    if (baseRevision !== undefined && baseRevision !== this.revision) {
      return { ok: false, reason: 'stale', revision: this.revision, data: this.current }
    }

    this.current = parsed.data
    this.revision += 1
    this.pending = this.snapshot()
    this.scheduleWrite()
    this.announce()
    return { ok: true, revision: this.revision }
  }

  /**
   * Tells listeners (main's broadcast to every window) about the committed change. The save is
   * already accepted, so a failing listener is logged and never turns it into a failed reply.
   */
  private announce(): void {
    try {
      this.options.onChange?.(this.snapshot())
    } catch (error) {
      this.options.log.error(`storage: broadcasting a ${this.name} change failed`, error)
    }
  }

  /** True from a save until its data is on disk (debounce, queued or in-flight write). */
  hasPendingWrite(): boolean {
    return this.pending !== undefined || this.inFlight > 0
  }

  /** Writes a pending save now and resolves once every write so far is on disk. */
  flush(): Promise<void> {
    this.clearTimer()
    if (this.pending !== undefined) {
      const snapshot = this.pending
      this.pending = undefined
      this.chain = this.chain.catch(() => {}).then(() => this.writeSnapshot(snapshot))
    }
    return this.chain
  }

  /**
   * Synchronous last-chance write for Windows session end, when no before-quit arrives and the
   * process may be killed before any promise settles. An async write already in progress can
   * still land after this one; writeSnapshot detects that and puts the newer data back.
   */
  flushSync(): void {
    this.clearTimer()
    if (this.pending === undefined && this.inFlight === 0) return
    this.writeNowSync()
  }

  private writeNowSync(): void {
    const snapshot = this.snapshot()
    this.backupSync()
    this.writeSync(this.path, serialize(snapshot.data))
    this.syncWrittenRevision = snapshot.revision
    this.pending = undefined
  }

  private scheduleWrite(): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      // A failure is logged in writeSnapshot and the data stays pending for the next flush.
      this.flush().catch(() => {})
    }, this.debounceMs)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private async writeSnapshot(snapshot: Snapshot<T>): Promise<void> {
    // A synchronous flush already put this revision (or a newer one) on disk.
    if (snapshot.revision <= this.syncWrittenRevision) return

    this.inFlight += 1
    try {
      await this.backup()
      await retrying(() => this.write(this.path, serialize(snapshot.data)), this.retryDelaysMs)
    } catch (error) {
      // Keep the data so the next flush (or the quit flush) tries again, unless newer data exists.
      this.pending ??= snapshot
      this.options.log.error(`storage: writing ${this.name} failed`, error)
      throw error
    } finally {
      this.inFlight -= 1
    }

    if (this.syncWrittenRevision > snapshot.revision) {
      // A session-end flushSync wrote newer data while this write was in progress, and this
      // write's rename just replaced it with older data: the disk now holds `snapshot`, so lower
      // the watermark (a retry must not be skipped) and put the newest data back.
      this.syncWrittenRevision = snapshot.revision
      this.options.log.warn(`storage: ${this.name} rewritten after an overlapping sync flush`)
      try {
        this.writeNowSync()
      } catch (error) {
        // Keep the newest data pending: the next save, flush or quit writes it again.
        this.pending = this.snapshot()
        this.options.log.error(
          `storage: ${this.name}: restoring newer data after an overlapping sync flush failed`,
          error
        )
        throw error
      }
    }
  }

  /** Copies the file about to be replaced to `<file>.bak`: the last known good version. */
  private async backup(): Promise<void> {
    try {
      await copyFile(this.path, backupPathFor(this.path))
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        this.options.log.warn(`storage: backing up ${this.name} failed`, error)
      }
    }
  }

  private backupSync(): void {
    try {
      copyFileSync(this.path, backupPathFor(this.path))
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        this.options.log.warn(`storage: backing up ${this.name} failed`, error)
      }
    }
  }
}
