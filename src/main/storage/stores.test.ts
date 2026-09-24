import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, emptyLayout, emptyTasks } from '@shared/defaults'
import { createStorage, DATA_FILES, type Storage } from './stores'

let dir: string
let storage: Storage

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'taskyard-stores-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function create(): Storage {
  storage = createStorage({
    dir,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => new Date('2026-09-23T10:15:30.123Z')
  })
  return storage
}

describe('createStorage', () => {
  it('keeps each data file in the userData folder', () => {
    expect(DATA_FILES).toEqual({
      settings: 'settings.json',
      layout: 'layout.json',
      tasks: 'tasks.json',
      ops: 'ops.json'
    })
    const s = create()
    expect(s.settings.path).toBe(join(dir, 'settings.json'))
    expect(s.layout.path).toBe(join(dir, 'layout.json'))
    expect(s.tasks.path).toBe(join(dir, 'tasks.json'))
    expect(s.ops.path).toBe(join(dir, 'ops.json'))
  })

  it('loads every store with defaults on first run', async () => {
    const s = create()

    await s.loadAll()

    expect(s.store('settings').get()).toEqual(defaultSettings())
    expect(s.store('layout').get()).toEqual(emptyLayout())
    expect(s.store('tasks').get()).toEqual(emptyTasks())
    expect(s.ops.list()).toEqual([])
    expect(s.status()).toEqual({ readOnly: [], recovered: [] })
  })

  it('flushAll writes every pending store', async () => {
    const s = create()
    await s.loadAll()
    s.settings.save({ ...defaultSettings(), theme: 'dark' })
    s.tasks.save({
      ...emptyTasks(),
      tasks: [{ id: 't', text: 'Write report', done: false, order: 0, createdAt: 1 }]
    })

    await s.flushAll()

    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).theme).toBe('dark')
    expect(JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')).tasks).toHaveLength(1)
    expect(existsSync(join(dir, 'layout.json'))).toBe(false)
  })

  it('flushAll still writes the other stores when one fails, then reports the failure', async () => {
    const s = create()
    await s.loadAll()
    const failing = vi.spyOn(s.layout, 'flush').mockRejectedValue(new Error('disk full'))
    s.settings.save({ ...defaultSettings(), theme: 'light' })

    await expect(s.flushAll()).rejects.toThrow(/layout: disk full/)

    expect(failing).toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).theme).toBe('light')
  })

  it('reports every accepted save of a renderer store through onChange, with its revision', async () => {
    const onChange = vi.fn()
    storage = createStorage({
      dir,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onChange
    })
    await storage.loadAll()
    const settings = { ...defaultSettings(), glow: false }
    const tasks = { ...emptyTasks(), tasks: [] }

    storage.settings.save(settings, 1)
    storage.tasks.save(tasks)
    storage.layout.save(emptyLayout(), 7)

    expect(onChange.mock.calls).toEqual([
      [{ store: 'settings', revision: 2, data: settings }],
      [{ store: 'tasks', revision: 2, data: tasks }]
    ])
  })

  it('hasPendingWrites() is true from a save until every store is on disk', async () => {
    const s = create()
    await s.loadAll()
    expect(s.hasPendingWrites()).toBe(false)

    s.layout.save(emptyLayout())
    expect(s.hasPendingWrites()).toBe(true)

    await s.flushAll()
    expect(s.hasPendingWrites()).toBe(false)
  })

  it('flushAllSync writes pending stores synchronously', async () => {
    const s = create()
    await s.loadAll()
    s.settings.save({ ...defaultSettings(), accent: 'purple' })

    s.flushAllSync()

    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).accent).toBe('purple')
  })

  it('reports recoveries and read-only files in status()', async () => {
    writeFileSync(join(dir, 'layout.json'), '<<garbage>>')
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 5 }))
    const s = create()

    await s.loadAll()

    expect(s.status()).toEqual({
      readOnly: [{ store: 'tasks', reason: 'future-version', version: 5 }],
      recovered: [
        {
          store: 'layout',
          restoredFrom: 'defaults',
          reason: 'unreadable-json',
          corruptPath: join(dir, 'layout.corrupt-2026-09-23T10-15-30.123Z.json')
        }
      ]
    })
  })
})
