import { randomUUID } from 'node:crypto'
import { lstat, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { emptyJournal } from '@shared/defaults'
import type { ReadOnlyInfo, StorageRecovered } from '@shared/ipc'
import { FILE_ID_PATTERN, OpsJournalSchema, type MoveOp, type MoveOpState } from '@shared/schema'
import { SCHEMA_VERSION } from '@shared/version'
import { fileIdOf, hashPath } from './file-hash'
import { OPS_MIGRATIONS } from './migrations'
import { DEFAULT_RETRY_DELAYS_MS, errorCode } from './retry'
import { loadVersionedFile, type StorageLog } from './versioned-file'

/** Legal state changes; `done → undone` is an Undo after a finished move. */
const TRANSITIONS: Readonly<Record<MoveOpState, readonly MoveOpState[]>> = {
  pending: ['copied', 'done', 'undone'],
  copied: ['done', 'undone'],
  done: ['undone'],
  undone: []
}

/**
 * Where a cross-volume move copies before its verified rename into `to`: a hidden temporary in
 * the destination folder, named after the op, so replay can always find and delete it.
 */
export function partialPathFor(op: Pick<MoveOp, 'token' | 'to'>): string {
  return join(dirname(op.to), `.taskyard-${op.token}.partial`)
}

export class JournalReadOnlyError extends Error {
  override name = 'JournalReadOnlyError'
}

export interface OpsJournalOptions {
  path: string
  log: StorageLog
  now?: () => Date
  newToken?: () => string
  hash?: (path: string) => Promise<string>
  writeSync?: (path: string, text: string) => void
}

export interface ReplayReport {
  /** Ops resolved to `done` by this replay (the move completed). */
  finished: MoveOp[]
  /** Ops resolved to `undone` by this replay (the move never happened or was rolled back). */
  rolledBack: MoveOp[]
  /**
   * File ids of destinations that no longer exist because their move was undone — rolled back
   * now, or earlier by a boot that died before pruning. Their placements must go.
   */
  removedIds: string[]
}

type Resolution = { state: 'done' | 'undone'; removedId?: string }

function isClosed(op: MoveOp): boolean {
  return op.state === 'done' || op.state === 'undone'
}

/** The file id at `path`, or null when nothing is there. */
async function idOf(path: string): Promise<string | null> {
  try {
    return await fileIdOf(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

/**
 * `ops.json`: the move journal. A move is appended (`pending`) and written synchronously before
 * any disk change, and rewritten after each step (`copied`, `done`/`undone`). On boot `replay`
 * resolves whatever a crash interrupted:
 * - `pending` → nothing to undo; the op is closed as `done` if the destination alone exists
 *   (an atomic rename completed), otherwise `undone`. The disk is never touched.
 * - `copied`  → the copy was verified before this state was written. If `to` holds it (its id
 *   is `toId`), `to` is never deleted: equal hashes → the source is deleted; different (the
 *   source was partly deleted, or a side was edited) → both are kept; either way `done`. If
 *   `to` is missing or holds another file, `to` is left alone and the op is `undone` (the
 *   source is still there).
 * Either way the op's temporary copy (`partialPathFor`), if a crash left one, is deleted.
 * Each resolution is written to ops.json before the next op is touched, and closed ops stay
 * journaled until `prune()`, which the boot step calls only once the layout no longer
 * references their ids, so a crash at any point still reports every removed id next boot.
 */
export class OpsJournal {
  readonly name = 'ops'
  readonly path: string

  private ops: MoveOp[] = []
  private loadedReadOnly: ReadOnlyInfo | null = null
  private loadedRecovered: StorageRecovered | null = null
  private readonly newToken: () => string
  private readonly hash: (path: string) => Promise<string>
  private readonly writeSync: (path: string, text: string) => void

  constructor(private readonly options: OpsJournalOptions) {
    this.path = options.path
    this.newToken = options.newToken ?? randomUUID
    this.hash = options.hash ?? hashPath
    this.writeSync = options.writeSync ?? ((path, text) => writeFileAtomic.sync(path, text, 'utf8'))
  }

  get readOnly(): ReadOnlyInfo | null {
    return this.loadedReadOnly
  }

  get recovered(): StorageRecovered | null {
    return this.loadedRecovered
  }

  async load(): Promise<void> {
    const outcome = await loadVersionedFile(
      {
        name: 'ops',
        path: this.path,
        schema: OpsJournalSchema,
        version: SCHEMA_VERSION,
        migrations: OPS_MIGRATIONS,
        defaults: emptyJournal
      },
      {
        log: this.options.log,
        now: this.options.now ?? (() => new Date()),
        retryDelaysMs: DEFAULT_RETRY_DELAYS_MS
      }
    )
    this.ops = outcome.data.ops
    this.loadedReadOnly = outcome.readOnly
    this.loadedRecovered = outcome.recovered
  }

  list(): readonly MoveOp[] {
    return this.ops
  }

  get(token: string): MoveOp | undefined {
    return this.ops.find((op) => op.token === token)
  }

  /** Journals a move as `pending`; ops.json is on disk when this returns. */
  begin(move: { from: string; to: string }): MoveOp {
    this.assertWritable()
    const op: MoveOp = { token: this.newToken(), from: move.from, to: move.to, state: 'pending' }
    this.ops = [...this.ops, op]
    this.persist()
    return op
  }

  /**
   * Records the next step of a move; ops.json is on disk when this returns. Pass the
   * destination's file id with `copied` (Phase 4's moveToDesktop does, right after the copy).
   */
  advance(token: string, state: MoveOpState, details: { toId?: string } = {}): MoveOp {
    this.assertWritable()
    const op = this.get(token)
    if (!op) throw new Error(`ops: unknown move token ${token}`)
    if (!TRANSITIONS[op.state].includes(state)) {
      throw new Error(`ops: illegal transition ${op.state} → ${state} for ${token}`)
    }
    if (details.toId !== undefined && !FILE_ID_PATTERN.test(details.toId)) {
      throw new Error(`ops: ${details.toId} is not a file id`)
    }
    const next: MoveOp = { ...op, state }
    if (details.toId !== undefined) next.toId = details.toId
    this.replace(next)
    return next
  }

  /**
   * Resolves every interrupted op, writing ops.json after each one. Closed ops stay journaled
   * until `prune()`.
   */
  async replay(): Promise<ReplayReport> {
    const report: ReplayReport = { finished: [], rolledBack: [], removedIds: [] }
    if (this.loadedReadOnly) {
      this.options.log.warn('ops: journal is read-only; replay skipped')
      return report
    }

    for (const op of this.ops) {
      if (isClosed(op)) continue
      let resolution: Resolution
      try {
        resolution = await this.resolve(op)
      } catch (error) {
        // Leave it journaled; the next boot tries again.
        this.options.log.error(`ops: replaying ${op.token} failed`, error)
        continue
      }
      // The only file a replay may remove besides the ones the resolution names: the op's own
      // temporary copy (never the user's source or destination).
      await rm(partialPathFor(op), { recursive: true, force: true })
      const closed: MoveOp = { ...op, state: resolution.state }
      if (resolution.removedId !== undefined) closed.toId = resolution.removedId
      // On disk before the next op is touched. A failure here aborts the replay (the boot step
      // logs it) rather than carry on with a journal that no longer matches the disk.
      this.replace(closed)
      if (closed.state === 'done') report.finished.push(closed)
      else report.rolledBack.push(closed)
    }

    // Every undone op whose destination is gone, including ones an earlier boot closed but
    // never pruned. `copied` records toId; a destination that still holds it was never removed.
    for (const op of this.ops) {
      if (op.state !== 'undone' || op.toId === undefined || report.removedIds.includes(op.toId)) {
        continue
      }
      if ((await idOf(op.to)) !== op.toId) report.removedIds.push(op.toId)
    }
    return report
  }

  /** Drops closed (`done`/`undone`) ops from ops.json. Called once their effects are saved. */
  prune(): void {
    if (this.loadedReadOnly) return // never rewrite a newer build's journal
    const open = this.ops.filter((op) => !isClosed(op))
    if (open.length === this.ops.length) return
    this.ops = open
    this.persist()
  }

  private async resolve(op: MoveOp): Promise<Resolution> {
    const [fromExists, toExists] = await Promise.all([exists(op.from), exists(op.to)])

    if (op.state === 'pending') {
      if (fromExists && toExists) {
        this.options.log.warn(
          `ops: pending move ${op.token} left ${op.from} and ${op.to}; untouched`
        )
      }
      return { state: !fromExists && toExists ? 'done' : 'undone' }
    }

    // copied: the copy was SHA-256 verified before `copied` was written (toId = its file id).
    // If `to` holds that file, it is the complete copy and is never deleted: only the source
    // delete may be missing. Anything else at `to` is not ours and is left alone.
    const toIsOurCopy = toExists && op.toId !== undefined && (await idOf(op.to)) === op.toId
    if (!toIsOurCopy) {
      if (toExists) {
        this.options.log.warn(
          `ops: ${op.token}: ${op.to} is not the verified copy; left alone, ${op.from} kept`
        )
      } else if (!fromExists) {
        this.options.log.error(`ops: ${op.token} has neither ${op.from} nor ${op.to}`)
      }
      // The copy never reached `to` (its partial is deleted by the caller): report its id.
      return { state: 'undone', removedId: op.toId }
    }
    if (!fromExists) return { state: 'done' }

    const [fromHash, toHash] = await Promise.all([this.hash(op.from), this.hash(op.to)])
    if (fromHash === toHash) {
      await rm(op.from, { recursive: true })
      this.options.log.info(`ops: finished ${op.token} (hashes match)`)
    } else {
      // The source was partly deleted, or one side was edited since: keep both.
      this.options.log.warn(
        `ops: ${op.token}: ${op.from} no longer matches the moved copy; both kept`
      )
    }
    return { state: 'done' }
  }

  private assertWritable(): void {
    if (this.loadedReadOnly) {
      throw new JournalReadOnlyError('ops.json is read-only (written by a newer Taskyard)')
    }
  }

  private replace(next: MoveOp): void {
    this.ops = this.ops.map((candidate) => (candidate.token === next.token ? next : candidate))
    this.persist()
  }

  private persist(): void {
    const file = { version: SCHEMA_VERSION, ops: this.ops }
    this.writeSync(this.path, `${JSON.stringify(file, null, 2)}\n`)
  }
}
