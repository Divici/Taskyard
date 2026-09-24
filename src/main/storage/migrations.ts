/** One upgrade step: receives a file at version N (a fresh copy) and returns it at version N + 1. */
export type Migration = (data: Record<string, unknown>) => Record<string, unknown>

/** Keyed by the version a step upgrades *from*. */
export type MigrationTable = Readonly<Record<number, Migration>>

export class MigrationError extends Error {
  override name = 'MigrationError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The file's `version`; a file written before versioning existed has none and counts as v0. */
export function readVersion(raw: unknown): number {
  if (!isRecord(raw)) throw new MigrationError('expected a JSON object')
  const version = raw['version']
  if (version === undefined) return 0
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new MigrationError(`invalid version ${JSON.stringify(version)}`)
  }
  return version
}

/**
 * Upgrades `raw` step by step to `target`, stamping `version` after each step. A file already at
 * `target` is returned as is; a newer file is an error (callers treat it as read-only first).
 */
export function migrate(raw: unknown, table: MigrationTable, target: number): unknown {
  let version = readVersion(raw)
  if (version > target) throw new MigrationError(`v${version} is newer than v${target}`)
  if (version === target) return raw

  let data = structuredClone(raw as Record<string, unknown>)
  while (version < target) {
    const step = table[version]
    if (!step) throw new MigrationError(`no migration from v${version}`)
    data = { ...step(data), version: version + 1 }
    version += 1
  }
  return data
}

// v0 is a file saved before the version stamp existed. Its shape matches v1, so the step stamps
// it and fills required containers; field defaults in schema.ts fill everything else.

export const SETTINGS_MIGRATIONS: MigrationTable = {
  0: (data) => ({ ...data })
}

export const LAYOUT_MIGRATIONS: MigrationTable = {
  0: (data) => ({
    ...data,
    displays: data['displays'] ?? [],
    paths: data['paths'] ?? {},
    lastSeen: data['lastSeen'] ?? {}
  })
}

export const TASKS_MIGRATIONS: MigrationTable = {
  0: (data) => ({ ...data, tasks: data['tasks'] ?? [] })
}

export const OPS_MIGRATIONS: MigrationTable = {
  0: (data) => ({ ...data, ops: data['ops'] ?? [] })
}
