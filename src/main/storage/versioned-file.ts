import { copyFile, readFile, rename } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { z } from 'zod'
import type { DataFileName, ReadOnlyInfo, StorageRecovered } from '@shared/ipc'
import { migrate, readVersion, type MigrationTable } from './migrations'
import { errorCode, retrying } from './retry'

export interface StorageLog {
  info(message: string, ...details: unknown[]): void
  warn(message: string, ...details: unknown[]): void
  error(message: string, ...details: unknown[]): void
}

/** What a versioned JSON file is and how to read it. */
export interface VersionedFileSpec<T> {
  name: DataFileName
  path: string
  schema: z.ZodType<T>
  /** The version this build writes. */
  version: number
  migrations: MigrationTable
  defaults: () => T
}

export interface LoadContext {
  log: StorageLog
  now: () => Date
  retryDelaysMs: readonly number[]
}

export interface LoadOutcome<T> {
  data: T
  recovered: StorageRecovered | null
  readOnly: ReadOnlyInfo | null
}

type Interpretation<T> =
  | { kind: 'valid'; data: T }
  | { kind: 'future'; version: number; raw: Record<string, unknown> }
  | { kind: 'corrupt'; reason: StorageRecovered['reason'] }

const BYTE_ORDER_MARK = 0xfeff

export function backupPathFor(path: string): string {
  return `${path}.bak`
}

/** `layout.json` → `layout.corrupt-2026-09-23T10-15-30.123Z.json` (no `:` — invalid on NTFS). */
export function corruptPathFor(path: string, at: Date): string {
  const ext = extname(path)
  const stem = basename(path, ext)
  const stamp = at.toISOString().replace(/:/g, '-')
  return join(dirname(path), `${stem}.corrupt-${stamp}${ext || '.json'}`)
}

/** parse → version check → migrate → validate. */
function interpret<T>(text: string, spec: VersionedFileSpec<T>): Interpretation<T> {
  let raw: unknown
  try {
    // A hand-edited file may start with a UTF-8 byte-order mark, which JSON.parse rejects.
    raw = JSON.parse(text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text)
  } catch {
    return { kind: 'corrupt', reason: 'unreadable-json' }
  }

  let version: number
  try {
    version = readVersion(raw)
  } catch {
    return { kind: 'corrupt', reason: 'invalid' }
  }
  if (version > spec.version) {
    return { kind: 'future', version, raw: raw as Record<string, unknown> }
  }

  let migrated: unknown
  try {
    migrated = migrate(raw, spec.migrations, spec.version)
  } catch {
    return { kind: 'corrupt', reason: 'migration-failed' }
  }

  const result = spec.schema.safeParse(migrated)
  return result.success
    ? { kind: 'valid', data: result.data }
    : { kind: 'corrupt', reason: 'invalid' }
}

async function readBackup<T>(spec: VersionedFileSpec<T>, ctx: LoadContext): Promise<T | null> {
  try {
    const text = await retrying(() => readFile(backupPathFor(spec.path), 'utf8'), ctx.retryDelaysMs)
    const backup = interpret(text, spec)
    return backup.kind === 'valid' ? backup.data : null
  } catch {
    return null
  }
}

/**
 * Loads a versioned JSON file and never throws:
 * - missing → defaults (first run);
 * - unreadable (locked, permissions) → defaults, read-only for the session;
 * - newer `version` → read-only; its data is used if it still fits the current schema;
 * - corrupt/invalid → quarantined as `*.corrupt-<iso>.json`, then `.bak` restored if valid,
 *   else defaults, with a `recovered` notice for the renderer.
 */
export async function loadVersionedFile<T>(
  spec: VersionedFileSpec<T>,
  ctx: LoadContext
): Promise<LoadOutcome<T>> {
  const { log } = ctx
  let text: string
  try {
    text = await retrying(() => readFile(spec.path, 'utf8'), ctx.retryDelaysMs)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { data: spec.defaults(), recovered: null, readOnly: null }
    }
    log.error(`storage: ${spec.name} could not be read; read-only this session`, error)
    return {
      data: spec.defaults(),
      recovered: null,
      readOnly: { store: spec.name, reason: 'read-error' }
    }
  }

  const found = interpret(text, spec)
  if (found.kind === 'valid') return { data: found.data, recovered: null, readOnly: null }

  if (found.kind === 'future') {
    const compatible = spec.schema.safeParse({ ...found.raw, version: spec.version })
    log.warn(
      `storage: ${spec.name} is v${found.version} (this build writes v${spec.version}); ` +
        `read-only, ${compatible.success ? 'using its compatible fields' : 'using defaults'}`
    )
    return {
      data: compatible.success ? compatible.data : spec.defaults(),
      recovered: null,
      readOnly: { store: spec.name, reason: 'future-version', version: found.version }
    }
  }

  const corruptPath = corruptPathFor(spec.path, ctx.now())
  try {
    await retrying(() => rename(spec.path, corruptPath), ctx.retryDelaysMs)
  } catch (error) {
    // Without moving it aside, a later save would destroy the only copy of the damaged file.
    log.error(`storage: ${spec.name} is ${found.reason} and could not be quarantined`, error)
    return {
      data: spec.defaults(),
      recovered: null,
      readOnly: { store: spec.name, reason: 'read-error' }
    }
  }

  const backup = await readBackup(spec, ctx)
  if (backup !== null) {
    try {
      await copyFile(backupPathFor(spec.path), spec.path)
    } catch (error) {
      log.warn(`storage: restoring ${spec.name} from .bak failed; the next save rewrites it`, error)
    }
  }
  const restoredFrom = backup !== null ? 'backup' : 'defaults'
  log.warn(`storage: ${spec.name} was ${found.reason}; kept ${corruptPath}, using ${restoredFrom}`)
  return {
    data: backup ?? spec.defaults(),
    recovered: { store: spec.name, restoredFrom, reason: found.reason, corruptPath },
    readOnly: null
  }
}
