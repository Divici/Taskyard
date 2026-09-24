import { describe, expect, it } from 'vitest'
import {
  LayoutFileSchema,
  OpsJournalSchema,
  SettingsFileSchema,
  TasksFileSchema
} from '@shared/schema'
import {
  LAYOUT_MIGRATIONS,
  migrate,
  MigrationError,
  OPS_MIGRATIONS,
  readVersion,
  SETTINGS_MIGRATIONS,
  TASKS_MIGRATIONS,
  type MigrationTable
} from './migrations'

describe('readVersion', () => {
  it('treats a file without a version stamp as v0', () => {
    expect(readVersion({ displays: [] })).toBe(0)
  })

  it('returns the stamped version', () => {
    expect(readVersion({ version: 3 })).toBe(3)
  })

  it.each([[null], [[]], ['text'], [{ version: '1' }], [{ version: 1.5 }], [{ version: -1 }]])(
    'rejects %j',
    (raw) => {
      expect(() => readVersion(raw)).toThrow(MigrationError)
    }
  )
})

describe('migrate', () => {
  const table: MigrationTable = {
    0: (data) => ({ ...data, renamed: data['old'], old: undefined }),
    1: (data) => ({ ...data, added: true })
  }

  it('runs each step from the file version up to the target and stamps the version', () => {
    expect(migrate({ old: 'x' }, table, 2)).toEqual({
      renamed: 'x',
      old: undefined,
      added: true,
      version: 2
    })
  })

  it('starts from the stamped version', () => {
    expect(migrate({ version: 1, keep: 1 }, table, 2)).toEqual({ version: 2, keep: 1, added: true })
  })

  it('returns a current file unchanged', () => {
    const current = { version: 2, a: 1 }

    expect(migrate(current, table, 2)).toBe(current)
  })

  it('does not mutate its input', () => {
    const input = { old: 'x' }

    migrate(input, table, 2)

    expect(input).toEqual({ old: 'x' })
  })

  it('throws when a step is missing', () => {
    expect(() => migrate({ version: 0 }, { 1: (d) => d }, 2)).toThrow(/no migration from v0/)
  })

  it('refuses to migrate a file newer than the target', () => {
    expect(() => migrate({ version: 3 }, table, 2)).toThrow(MigrationError)
  })
})

describe('v0 → v1', () => {
  it('stamps an unversioned settings file and keeps its values', () => {
    const migrated = migrate({ theme: 'dark', glassBlur: 8 }, SETTINGS_MIGRATIONS, 1)

    expect(migrated).toEqual({ version: 1, theme: 'dark', glassBlur: 8 })
    expect(SettingsFileSchema.parse(migrated)).toMatchObject({
      version: 1,
      theme: 'dark',
      glassBlur: 8,
      glassOpacity: 40
    })
  })

  it('stamps an unversioned layout and fills the top-level maps', () => {
    const v0 = {
      displays: [{ displayId: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 } }]
    }

    const migrated = migrate(v0, LAYOUT_MIGRATIONS, 1)

    expect(migrated).toEqual({ ...v0, version: 1, paths: {}, lastSeen: {} })
    expect(LayoutFileSchema.safeParse(migrated).success).toBe(true)
  })

  it('stamps unversioned tasks and journal files', () => {
    const tasks = migrate({ tasks: [] }, TASKS_MIGRATIONS, 1)
    const ops = migrate({ ops: [] }, OPS_MIGRATIONS, 1)

    expect(TasksFileSchema.parse(tasks).version).toBe(1)
    expect(OpsJournalSchema.parse(ops)).toEqual({ version: 1, ops: [] })
  })
})
