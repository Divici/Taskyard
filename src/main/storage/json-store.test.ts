import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/defaults'
import { SettingsFileSchema, type SettingsFile } from '@shared/schema'
import { SCHEMA_VERSION } from '@shared/version'
import { installQuitFlush } from '../app/quit-flush'
import { JsonStore, type JsonStoreOptions } from './json-store'
import { SETTINGS_MIGRATIONS } from './migrations'

const NOW = new Date('2026-09-23T10:15:30.123Z')
const CORRUPT_NAME = 'settings.corrupt-2026-09-23T10-15-30.123Z.json'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'taskyard-store-'))
  file = join(dir, 'settings.json')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function quietLog(): JsonStoreOptions<SettingsFile>['log'] {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function createStore(
  overrides: Partial<JsonStoreOptions<SettingsFile>> = {}
): JsonStore<SettingsFile> {
  return new JsonStore<SettingsFile>({
    name: 'settings',
    path: file,
    schema: SettingsFileSchema,
    version: SCHEMA_VERSION,
    migrations: SETTINGS_MIGRATIONS,
    defaults: defaultSettings,
    log: quietLog(),
    now: () => NOW,
    retryDelaysMs: [0, 0, 0],
    ...overrides
  })
}

function settings(patch: Partial<SettingsFile>): SettingsFile {
  return { ...defaultSettings(), ...patch }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('JsonStore', () => {
  it('round-trips: a saved and flushed file loads back identically', async () => {
    const first = createStore()
    expect(await first.load()).toEqual(defaultSettings())

    const changed = settings({ theme: 'dark', glassBlur: 24, firstRunDone: true })
    expect(first.save(changed)).toEqual({ ok: true, revision: 2 })
    await first.flush()

    const second = createStore()
    expect(await second.load()).toEqual(changed)
    expect(second.get()).toEqual(changed)
    expect(readJson(file)).toEqual(changed)
    expect(second.recovered).toBeNull()
    expect(second.readOnly).toBeNull()
  })

  it('serves defaults before load and when the file does not exist yet', async () => {
    const store = createStore()

    expect(store.get()).toEqual(defaultSettings())
    await store.load()
    expect(store.recovered).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('recovers a corrupt file from .bak and keeps the corrupt copy', async () => {
    const backup = settings({ theme: 'light', accent: 'purple' })
    writeFileSync(`${file}.bak`, JSON.stringify(backup))
    writeFileSync(file, '{"version":1,"theme":')

    const store = createStore()
    const loaded = await store.load()

    expect(loaded).toEqual(backup)
    expect(store.recovered).toEqual({
      store: 'settings',
      restoredFrom: 'backup',
      reason: 'unreadable-json',
      corruptPath: join(dir, CORRUPT_NAME)
    })
    expect(readFileSync(join(dir, CORRUPT_NAME), 'utf8')).toBe('{"version":1,"theme":')
    // The backup is restored as the live file straight away.
    expect(readJson(file)).toEqual(backup)
  })

  it('falls back to defaults when the file is invalid and there is no usable .bak', async () => {
    writeFileSync(file, JSON.stringify(settings({ glassOpacity: 500 })))
    writeFileSync(`${file}.bak`, 'not json either')

    const store = createStore()

    expect(await store.load()).toEqual(defaultSettings())
    expect(store.recovered).toEqual({
      store: 'settings',
      restoredFrom: 'defaults',
      reason: 'invalid',
      corruptPath: join(dir, CORRUPT_NAME)
    })
    expect(existsSync(file)).toBe(false)
  })

  it('coalesces 10 saves inside the 300 ms debounce into one write of the last value', async () => {
    vi.useFakeTimers()
    const write = vi.fn(async () => {})
    const store = createStore({ write })
    await store.load()

    for (let blur = 0; blur < 10; blur++) {
      store.save(settings({ glassBlur: blur }))
      await vi.advanceTimersByTimeAsync(20)
    }
    await vi.advanceTimersByTimeAsync(299)
    expect(write).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await store.flush()

    expect(write).toHaveBeenCalledOnce()
    const [path, text] = write.mock.calls[0] as unknown as [string, string]
    expect(path).toBe(file)
    expect(JSON.parse(text)).toEqual(settings({ glassBlur: 9 }))
  })

  it('flush writes a pending save immediately, without waiting for the debounce', async () => {
    const store = createStore({ debounceMs: 60_000 })
    await store.load()

    store.save(settings({ theme: 'dark' }))
    expect(store.hasPendingWrite()).toBe(true)
    await store.flush()

    expect(store.hasPendingWrite()).toBe(false)
    expect(readJson(file)).toEqual(settings({ theme: 'dark' }))
  })

  it('reads a file saved with a UTF-8 byte-order mark (e.g. by older Notepad)', async () => {
    const bom = String.fromCharCode(0xfeff)
    writeFileSync(file, `${bom}${JSON.stringify(settings({ theme: 'light' }))}`)
    expect(readFileSync(file).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))

    const store = createStore()

    expect(await store.load()).toEqual(settings({ theme: 'light' }))
    expect(store.recovered).toBeNull()
  })

  it('flush with nothing pending resolves without writing', async () => {
    const write = vi.fn(async () => {})
    const store = createStore({ write })
    await store.load()

    await store.flush()

    expect(write).not.toHaveBeenCalled()
  })

  it('keeps the previous version as <file>.bak on every write', async () => {
    const store = createStore()
    await store.load()

    store.save(settings({ accent: 'blue' }))
    await store.flush()
    store.save(settings({ accent: 'white' }))
    await store.flush()

    expect(readJson(file)).toEqual(settings({ accent: 'white' }))
    expect(readJson(`${file}.bak`)).toEqual(settings({ accent: 'blue' }))
  })

  it('migrates a v0 file on load', async () => {
    writeFileSync(file, JSON.stringify({ theme: 'light' }))

    const store = createStore()

    expect(await store.load()).toEqual(settings({ theme: 'light' }))
    expect(store.recovered).toBeNull()
  })

  it('enters read-only mode for a future version and never overwrites the file', async () => {
    const future = JSON.stringify({ ...settings({ theme: 'dark' }), version: 2, newField: 1 })
    writeFileSync(file, future)

    const store = createStore()
    const loaded = await store.load()

    expect(loaded.theme).toBe('dark')
    expect(store.readOnly).toEqual({ store: 'settings', reason: 'future-version', version: 2 })
    expect(store.save(settings({ theme: 'light' }))).toEqual({ ok: false, reason: 'read-only' })
    expect(store.get().theme).toBe('dark')
    await store.flush()
    store.flushSync()

    expect(readFileSync(file, 'utf8')).toBe(future)
    expect(existsSync(`${file}.bak`)).toBe(false)
  })

  it('uses defaults in read-only mode when the future file does not fit the current schema', async () => {
    writeFileSync(file, JSON.stringify({ version: 9, theme: { mode: 'dark' } }))

    const store = createStore()

    expect(await store.load()).toEqual(defaultSettings())
    expect(store.readOnly).toEqual({ store: 'settings', reason: 'future-version', version: 9 })
  })

  it('enters read-only mode when the file exists but cannot be read', async () => {
    mkdirSync(file)

    const store = createStore()

    expect(await store.load()).toEqual(defaultSettings())
    expect(store.readOnly).toEqual({ store: 'settings', reason: 'read-error' })
    expect(store.save(settings({ theme: 'dark' }))).toEqual({ ok: false, reason: 'read-only' })
  })

  it('rejects invalid data without touching the stored value', async () => {
    const store = createStore()
    await store.load()

    expect(() => store.save({ ...defaultSettings(), glassOpacity: 500 })).toThrow(
      /invalid settings data/
    )
    expect(store.get()).toEqual(defaultSettings())
    expect(store.hasPendingWrite()).toBe(false)
  })

  it('retries a transient EPERM (antivirus or indexer holding the file)', async () => {
    const write = vi
      .fn<(path: string, text: string) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EPERM' }))
      .mockResolvedValueOnce(undefined)
    const store = createStore({ write })
    await store.load()

    store.save(settings({ theme: 'dark' }))
    await store.flush()

    expect(write).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed write pending so the next flush retries it', async () => {
    const write = vi
      .fn<(path: string, text: string) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'ENOSPC' }))
      .mockResolvedValueOnce(undefined)
    const log = quietLog()
    const store = createStore({ write, log })
    await store.load()

    store.save(settings({ theme: 'dark' }))
    await expect(store.flush()).rejects.toThrow('denied')
    expect(store.hasPendingWrite()).toBe(true)
    expect(log.error).toHaveBeenCalled()

    await store.flush()
    expect(write).toHaveBeenCalledTimes(2)
    expect(store.hasPendingWrite()).toBe(false)
  })

  it('flushSync writes a pending save synchronously', async () => {
    const store = createStore({ debounceMs: 60_000 })
    await store.load()

    store.save(settings({ iconSize: 'large' }))
    store.flushSync()

    expect(readJson(file)).toEqual(settings({ iconSize: 'large' }))
    expect(store.hasPendingWrite()).toBe(false)
  })

  it('has a change saved 100 ms before quit on disk once before-quit finishes', async () => {
    const store = createStore()
    await store.load()
    const app = Object.assign(new EventEmitter(), { quit: vi.fn() })
    installQuitFlush(
      app,
      { flushAll: () => store.flush(), hasPendingWrites: () => store.hasPendingWrite() },
      quietLog()
    )

    store.save(settings({ theme: 'dark' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const beforeQuit = { preventDefault: vi.fn() }
    app.emit('before-quit', beforeQuit)

    expect(beforeQuit.preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())
    expect(readJson(file)).toEqual(settings({ theme: 'dark' }))
  })
})

describe('JsonStore revisions', () => {
  it('starts at revision 1 once loaded', async () => {
    const store = createStore()

    await store.load()

    expect(store.snapshot()).toEqual({ revision: 1, data: defaultSettings() })
  })

  it('accepts a save based on the current revision, bumps it and reports the change', async () => {
    const onChange = vi.fn()
    const store = createStore({ onChange })
    await store.load()
    const next = settings({ theme: 'dark' })

    expect(store.save(next, 1)).toEqual({ ok: true, revision: 2 })

    expect(store.snapshot()).toEqual({ revision: 2, data: next })
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ revision: 2, data: next })
  })

  it('rejects a stale save with the current revision and data, changing nothing', async () => {
    const onChange = vi.fn()
    const store = createStore({ onChange })
    await store.load()
    const first = settings({ accent: 'blue' })
    store.save(first, 1)
    await store.flush()

    const result = store.save(settings({ accent: 'white' }), 1)

    expect(result).toEqual({ ok: false, reason: 'stale', revision: 2, data: first })
    expect(store.snapshot()).toEqual({ revision: 2, data: first })
    expect(store.hasPendingWrite()).toBe(false)
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('accepts a main-side save that carries no base revision', async () => {
    const store = createStore()
    await store.load()

    expect(store.save(settings({ glow: false }))).toEqual({ ok: true, revision: 2 })
    expect(store.save(settings({ glow: true }))).toEqual({ ok: true, revision: 3 })
  })

  it('refuses a read-only store whatever the revision says', async () => {
    writeFileSync(file, JSON.stringify({ ...defaultSettings(), version: 2 }))
    const onChange = vi.fn()
    const store = createStore({ onChange })
    await store.load()

    expect(store.save(settings({ theme: 'dark' }), 1)).toEqual({ ok: false, reason: 'read-only' })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('JsonStore flushSync ordering', () => {
  /** An atomic write whose rename (the moment data lands on disk) waits for release(). */
  function delayedWrite(): {
    write: ReturnType<typeof vi.fn>
    release: (index: number) => void
  } {
    const releases: Array<() => void> = []
    const write = vi.fn(
      (path: string, text: string) =>
        new Promise<void>((resolve) => {
          releases.push(() => {
            writeFileSync(path, text)
            resolve()
          })
        })
    )
    return { write, release: (index) => releases[index]() }
  }

  it('a session-end flushSync is not undone by an older async write that lands later', async () => {
    const { write, release } = delayedWrite()
    const store = createStore({ write })
    await store.load()
    store.save(settings({ accent: 'blue' }))
    const flushing = store.flush()
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())

    store.save(settings({ accent: 'white' }))
    store.flushSync()
    expect(readJson(file)).toEqual(settings({ accent: 'white' }))

    release(0) // the older write's rename finally lands
    await flushing

    expect(readJson(file)).toEqual(settings({ accent: 'white' }))
    expect(store.hasPendingWrite()).toBe(false)
  })

  it('skips a queued async write that a flushSync already superseded', async () => {
    const { write, release } = delayedWrite()
    const store = createStore({ write })
    await store.load()
    store.save(settings({ accent: 'blue' }))
    const first = store.flush()
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    store.save(settings({ accent: 'purple' }))
    const queued = store.flush()

    store.save(settings({ accent: 'white' }))
    store.flushSync()
    release(0)
    await first
    await queued

    expect(write).toHaveBeenCalledOnce()
    expect(readJson(file)).toEqual(settings({ accent: 'white' }))
  })

  it('writes once when the in-flight write already carries the latest data', async () => {
    const { write, release } = delayedWrite()
    const writeSync = vi.fn((path: string, text: string) => writeFileSync(path, text))
    const store = createStore({ write, writeSync })
    await store.load()
    store.save(settings({ accent: 'blue' }))
    const flushing = store.flush()
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())

    store.flushSync()
    release(0)
    await flushing

    expect(writeSync).toHaveBeenCalledOnce()
    expect(readJson(file)).toEqual(settings({ accent: 'blue' }))
  })
})

describe('JsonStore failure isolation', () => {
  it('logs a failed restore after an overlapping sync flush and keeps the newest data pending', async () => {
    let release!: () => void
    const write = vi.fn(
      (path: string, text: string) =>
        new Promise<void>((resolve) => {
          release = () => {
            writeFileSync(path, text)
            resolve()
          }
        })
    )
    let failSync = false
    const writeSync = vi.fn((path: string, text: string) => {
      if (failSync) throw Object.assign(new Error('disk gone'), { code: 'EIO' })
      writeFileSync(path, text)
    })
    const log = quietLog()
    const store = createStore({ write, writeSync, log })
    await store.load()
    store.save(settings({ accent: 'blue' }))
    const flushing = store.flush()
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    store.save(settings({ accent: 'white' }))
    store.flushSync()

    failSync = true
    release() // the older write lands over the sync write; restoring it fails
    await expect(flushing).rejects.toThrow('disk gone')

    expect(log.error).toHaveBeenCalledWith(
      'storage: settings: restoring newer data after an overlapping sync flush failed',
      expect.objectContaining({ message: 'disk gone' })
    )
    expect(store.hasPendingWrite()).toBe(true)
    expect(readJson(file)).toEqual(settings({ accent: 'blue' }))

    failSync = false
    const retry = store.flush()
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    release()
    await retry
    expect(readJson(file)).toEqual(settings({ accent: 'white' }))
    expect(store.hasPendingWrite()).toBe(false)
  })

  it('a broadcast that throws is logged and never turns a committed save into a failure', async () => {
    const log = quietLog()
    const store = createStore({
      log,
      onChange: () => {
        throw new Error('renderer gone')
      }
    })
    await store.load()

    const result = store.save(settings({ theme: 'dark' }), 1)

    expect(result).toEqual({ ok: true, revision: 2 })
    expect(store.get().theme).toBe('dark')
    expect(store.hasPendingWrite()).toBe(true)
    expect(log.error).toHaveBeenCalledWith(
      'storage: broadcasting a settings change failed',
      expect.objectContaining({ message: 'renderer gone' })
    )
  })
})
