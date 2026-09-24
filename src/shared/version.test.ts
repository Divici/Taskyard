import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyJournal, emptyLayout, emptyTasks, defaultSettings } from './defaults'
import { LayoutFileSchema, SCHEMA_VERSION as SCHEMA_VERSION_FROM_SCHEMA } from './schema'
import { SCHEMA_VERSION } from './version'

const SRC = join(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
    )
    .map((entry) => join(entry.parentPath, entry.name))
}

describe('SCHEMA_VERSION', () => {
  it('lives in a zod-free module, so the renderer can use it without bundling zod', () => {
    const text = readFileSync(join(__dirname, 'version.ts'), 'utf8')

    expect(text).not.toMatch(/from 'zod'/)
    expect(SCHEMA_VERSION).toBe(1)
    expect(SCHEMA_VERSION_FROM_SCHEMA).toBe(SCHEMA_VERSION)
  })

  it('stamps every default file', () => {
    for (const file of [defaultSettings(), emptyLayout(), emptyTasks(), emptyJournal()]) {
      expect(file.version).toBe(SCHEMA_VERSION)
    }
    expect(LayoutFileSchema.safeParse({ version: SCHEMA_VERSION }).success).toBe(true)
  })

  it('is never hard-coded as a literal in renderer or shared sources', () => {
    const offenders = [...sources(join(SRC, 'renderer')), ...sources(join(SRC, 'shared'))].filter(
      (path) => /\bversion:\s*1\b/.test(readFileSync(path, 'utf8'))
    )

    expect(offenders).toEqual([])
  })
})
