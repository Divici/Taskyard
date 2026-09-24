import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLayout, newDisplayLayout } from '@shared/defaults'
import { LayoutFileSchema, type LayoutFile } from '@shared/schema'
import { SCHEMA_VERSION } from '@shared/version'
import { boot } from '../app/boot'
import { JsonStore } from './json-store'
import { replayJournal } from './journal-replay'
import { LAYOUT_MIGRATIONS } from './migrations'
import { JournalReadOnlyError, OpsJournal } from './ops-journal'

let root: string
let journalPath: string
let source: string
let desktop: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'taskyard-ops-'))
  journalPath = join(root, 'ops.json')
  source = join(root, 'volume-d')
  desktop = join(root, 'desktop')
  mkdirSync(source)
  mkdirSync(desktop)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function quietLog(): {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function createJournal(): OpsJournal {
  return new OpsJournal({ path: journalPath, log: quietLog() })
}

function readJournal(): {
  version: number
  ops: Array<{ token: string; state: string; toId?: string }>
} {
  return JSON.parse(readFileSync(journalPath, 'utf8'))
}

function fileIdOf(path: string): string {
  const stats = statSync(path, { bigint: true })
  return `${stats.dev}:${stats.ino}`
}

/** A journaled move that reached `copied` before the app died, reloaded as on the next boot. */
async function crashedAfterCopy(
  from: string,
  to: string
): Promise<{ token: string; journal: OpsJournal }> {
  const before = createJournal()
  await before.load()
  const op = before.begin({ from, to })
  before.advance(op.token, 'copied', existsSync(to) ? { toId: fileIdOf(to) } : {})

  const journal = createJournal()
  await journal.load()
  return { token: op.token, journal }
}

describe('OpsJournal', () => {
  it('writes a pending op to ops.json synchronously, before begin() returns', async () => {
    const journal = createJournal()
    await journal.load()

    const op = journal.begin({ from: join(source, 'a.txt'), to: join(desktop, 'a.txt') })

    expect(op.state).toBe('pending')
    expect(readJournal()).toEqual({ version: 1, ops: [op] })
  })

  it('rewrites the journal after each step', async () => {
    const journal = createJournal()
    await journal.load()
    const op = journal.begin({ from: join(source, 'a.txt'), to: join(desktop, 'a.txt') })

    journal.advance(op.token, 'copied')
    expect(readJournal().ops[0].state).toBe('copied')

    journal.advance(op.token, 'done')
    expect(readJournal().ops[0].state).toBe('done')
    expect(journal.get(op.token)?.state).toBe('done')
  })

  it('records the destination file id when a move reaches copied', async () => {
    const journal = createJournal()
    await journal.load()
    const op = journal.begin({ from: join(source, 'a.txt'), to: join(desktop, 'a.txt') })

    journal.advance(op.token, 'copied', { toId: '12:34' })

    expect(readJournal().ops[0]).toMatchObject({ state: 'copied', toId: '12:34' })
    expect(() => journal.advance(op.token, 'done', { toId: 'C:\\a.txt' })).toThrow(/file id/)
  })

  it('rejects an illegal transition and an unknown token', async () => {
    const journal = createJournal()
    await journal.load()
    const op = journal.begin({ from: 'a', to: 'b' })
    journal.advance(op.token, 'undone')

    expect(() => journal.advance(op.token, 'copied')).toThrow(/undone → copied/)
    expect(() => journal.advance('missing', 'done')).toThrow(/unknown move token/)
  })

  it('replay finishes a copied op whose hashes match: the source is deleted, the op is done', async () => {
    const from = join(source, 'report.pdf')
    const to = join(desktop, 'report.pdf')
    writeFileSync(from, 'same bytes')
    writeFileSync(to, 'same bytes')
    const { token, journal } = await crashedAfterCopy(from, to)

    const report = await journal.replay()

    expect(report.finished.map((op) => op.token)).toEqual([token])
    expect(report.finished[0].state).toBe('done')
    expect(report.rolledBack).toEqual([])
    expect(report.removedIds).toEqual([])
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(to, 'utf8')).toBe('same bytes')
  })

  it('replay rolls back a copied op on hash mismatch and reports the removed destination id', async () => {
    const from = join(source, 'video.mp4')
    const to = join(desktop, 'video.mp4')
    writeFileSync(from, 'the complete original')
    writeFileSync(to, 'the complete') // truncated copy
    const toId = fileIdOf(to)
    const { token, journal } = await crashedAfterCopy(from, to)

    const report = await journal.replay()

    expect(report.rolledBack.map((op) => op.token)).toEqual([token])
    expect(report.rolledBack[0].state).toBe('undone')
    expect(report.removedIds).toEqual([toId])
    expect(existsSync(to)).toBe(false)
    expect(readFileSync(from, 'utf8')).toBe('the complete original')
  })

  it('replay compares whole folders, not just files', async () => {
    const from = join(source, 'Photos')
    const to = join(desktop, 'Photos')
    for (const dir of [from, to]) {
      mkdirSync(join(dir, 'nested'), { recursive: true })
      writeFileSync(join(dir, 'a.jpg'), 'aaa')
      writeFileSync(join(dir, 'nested', 'b.jpg'), 'bbb')
    }
    const { journal } = await crashedAfterCopy(from, to)

    const report = await journal.replay()

    expect(report.finished).toHaveLength(1)
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(join(to, 'nested', 'b.jpg'), 'utf8')).toBe('bbb')
  })

  it('replay rolls back a folder copy that is missing a file', async () => {
    const from = join(source, 'Photos')
    const to = join(desktop, 'Photos')
    mkdirSync(join(from, 'nested'), { recursive: true })
    writeFileSync(join(from, 'a.jpg'), 'aaa')
    writeFileSync(join(from, 'nested', 'b.jpg'), 'bbb')
    mkdirSync(to)
    writeFileSync(join(to, 'a.jpg'), 'aaa')
    const toId = fileIdOf(to)
    const { journal } = await crashedAfterCopy(from, to)

    const report = await journal.replay()

    expect(report.removedIds).toEqual([toId])
    expect(existsSync(to)).toBe(false)
    expect(existsSync(join(from, 'nested', 'b.jpg'))).toBe(true)
  })

  it('replay treats a copied op whose source is already gone as finished', async () => {
    const from = join(source, 'gone.txt')
    const to = join(desktop, 'gone.txt')
    writeFileSync(to, 'moved')
    const { journal } = await crashedAfterCopy(from, to)

    const report = await journal.replay()

    expect(report.finished).toHaveLength(1)
    expect(readFileSync(to, 'utf8')).toBe('moved')
  })

  it('replay never touches the disk for a pending op', async () => {
    const from = join(source, 'a.txt')
    const to = join(desktop, 'a.txt')
    writeFileSync(from, 'original')
    writeFileSync(to, 'partial')
    const before = createJournal()
    await before.load()
    before.begin({ from, to })

    const journal = createJournal()
    await journal.load()
    const report = await journal.replay()

    expect(report.removedIds).toEqual([])
    expect(readFileSync(from, 'utf8')).toBe('original')
    expect(readFileSync(to, 'utf8')).toBe('partial')
  })

  it('replay records each resolution in ops.json; prune() then drops the closed ops', async () => {
    const from = join(source, 'a.txt')
    writeFileSync(from, 'x')
    const before = createJournal()
    await before.load()
    const pending = before.begin({ from, to: join(desktop, 'a.txt') })
    const done = before.begin({ from: 'x', to: 'y' })
    before.advance(done.token, 'done')

    const journal = createJournal()
    await journal.load()
    await journal.replay()

    expect(readJournal().ops.map((op) => [op.token, op.state])).toEqual([
      [pending.token, 'undone'],
      [done.token, 'done']
    ])

    journal.prune()

    expect(journal.list()).toEqual([])
    expect(readJournal()).toEqual({ version: 1, ops: [] })
  })

  it('still reports the removed id after a crash between deleting the copy and rewriting ops.json', async () => {
    const from = join(source, 'video.mp4')
    const to = join(desktop, 'video.mp4')
    writeFileSync(from, 'original')
    // The rollback already deleted `to`, then the app died before ops.json changed.
    writeFileSync(
      journalPath,
      JSON.stringify({
        version: 1,
        ops: [{ token: 't1', from, to, state: 'copied', toId: '77:88' }]
      })
    )
    const journal = createJournal()
    await journal.load()

    const report = await journal.replay()

    expect(report.rolledBack.map((op) => op.token)).toEqual(['t1'])
    expect(report.removedIds).toEqual(['77:88'])
    expect(readFileSync(from, 'utf8')).toBe('original')
  })

  it('rewrites ops.json after every resolved op, so a crash mid-replay loses no removed id', async () => {
    const moves = ['a.bin', 'b.bin'].map((name) => ({
      from: join(source, name),
      to: join(desktop, name)
    }))
    for (const { from, to } of moves) {
      writeFileSync(from, 'complete')
      writeFileSync(to, 'partial')
    }
    const ids = moves.map(({ to }) => fileIdOf(to))
    const setup = createJournal()
    await setup.load()
    for (const { from, to } of moves) {
      setup.advance(setup.begin({ from, to }).token, 'copied', { toId: fileIdOf(to) })
    }

    // First boot dies while writing ops.json after the second rollback.
    let writes = 0
    const crashing = new OpsJournal({
      path: journalPath,
      log: quietLog(),
      writeSync: (path, text) => {
        writes += 1
        if (writes === 2) throw new Error('power cut')
        writeFileSync(path, text)
      }
    })
    await crashing.load()
    await expect(crashing.replay()).rejects.toThrow('power cut')
    expect(moves.map(({ to }) => existsSync(to))).toEqual([false, false])
    expect(readJournal().ops.map((op) => op.state)).toEqual(['undone', 'copied'])

    // Second boot still reports both destinations.
    const journal = createJournal()
    await journal.load()
    const report = await journal.replay()

    expect(report.removedIds).toEqual(ids)
    expect(moves.map(({ from }) => readFileSync(from, 'utf8'))).toEqual(['complete', 'complete'])
  })

  it('replay leaves the disk alone when there is nothing to replay', async () => {
    const journal = createJournal()
    await journal.load()

    expect(await journal.replay()).toEqual({ finished: [], rolledBack: [], removedIds: [] })
    expect(existsSync(journalPath)).toBe(false)
  })

  it('refuses to journal a move, and skips replay, when ops.json is from a newer version', async () => {
    const future = JSON.stringify({ version: 2, ops: [{ token: 't', future: true }] })
    writeFileSync(journalPath, future)
    const journal = createJournal()
    await journal.load()

    expect(journal.readOnly).toEqual({ store: 'ops', reason: 'future-version', version: 2 })
    expect(() => journal.begin({ from: 'a', to: 'b' })).toThrow(JournalReadOnlyError)
    expect(await journal.replay()).toEqual({ finished: [], rolledBack: [], removedIds: [] })
    expect(readFileSync(journalPath, 'utf8')).toBe(future)
  })

  it('quarantines a corrupt journal and starts empty', async () => {
    writeFileSync(journalPath, '{"version":1,"ops":[{')
    const journal = createJournal()
    await journal.load()

    expect(journal.list()).toEqual([])
    expect(journal.recovered).toMatchObject({ store: 'ops', restoredFrom: 'defaults' })
  })
})

describe('replayJournal (boot step)', () => {
  function layoutStore(): JsonStore<LayoutFile> {
    return new JsonStore<LayoutFile>({
      name: 'layout',
      path: join(root, 'layout.json'),
      schema: LayoutFileSchema,
      version: SCHEMA_VERSION,
      migrations: LAYOUT_MIGRATIONS,
      defaults: emptyLayout,
      log: quietLog()
    })
  }

  it('emits desktop:changed {removed:[toIds]} and forgets the placement of a rolled-back op', async () => {
    const from = join(source, 'a.txt')
    const to = join(desktop, 'a.txt')
    writeFileSync(from, 'full')
    writeFileSync(to, 'fu')
    const toId = fileIdOf(to)
    const { journal } = await crashedAfterCopy(from, to)
    const layout = layoutStore()
    await layout.load()
    const display = newDisplayLayout(1, { x: 0, y: 0, width: 2560, height: 1440 })
    layout.save({
      ...emptyLayout(),
      displays: [{ ...display, loose: { [toId]: { x: 8, y: 8 }, '1:1': { x: 96, y: 8 } } }],
      paths: { [toId]: to }
    })
    const emit = vi.fn()

    await replayJournal({ journal, layout, emit, log: quietLog() })

    expect(emit).toHaveBeenCalledExactlyOnceWith('desktop:changed', {
      added: [],
      removed: [toId],
      changed: []
    })
    expect(layout.get().displays[0].loose).toEqual({ '1:1': { x: 96, y: 8 } })
    expect(layout.get().paths).toEqual({})
    // The scrub is on disk before the closed op leaves the journal.
    const onDisk = JSON.parse(readFileSync(join(root, 'layout.json'), 'utf8')) as LayoutFile
    expect(onDisk.displays[0].loose).toEqual({ '1:1': { x: 96, y: 8 } })
    expect(readJournal().ops).toEqual([])
  })

  it('warns, and keeps the op journaled, when a read-only layout refuses the scrub', async () => {
    const from = join(source, 'a.txt')
    const to = join(desktop, 'a.txt')
    writeFileSync(from, 'full')
    writeFileSync(to, 'fu')
    const toId = fileIdOf(to)
    const { journal } = await crashedAfterCopy(from, to)
    writeFileSync(
      join(root, 'layout.json'),
      JSON.stringify({ version: 2, displays: [], paths: { [toId]: to }, lastSeen: {} })
    )
    const layout = layoutStore()
    await layout.load()
    const log = quietLog()
    const emit = vi.fn()

    await replayJournal({ journal, layout, emit, log })

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/layout is read-only.*1 removed id/)
    )
    expect(emit).toHaveBeenCalledOnce()
    expect(readJournal().ops.map((op) => op.state)).toEqual(['undone'])
  })

  it('prunes closed ops when nothing needed scrubbing', async () => {
    const before = createJournal()
    await before.load()
    before.advance(before.begin({ from: 'x', to: 'y' }).token, 'done')
    const journal = createJournal()
    await journal.load()
    const layout = layoutStore()
    await layout.load()

    await replayJournal({ journal, layout, emit: vi.fn(), log: quietLog() })

    expect(readJournal().ops).toEqual([])
  })

  it('emits nothing when no op was rolled back', async () => {
    const journal = createJournal()
    await journal.load()
    const layout = layoutStore()
    await layout.load()
    const emit = vi.fn()

    await replayJournal({ journal, layout, emit, log: quietLog() })

    expect(emit).not.toHaveBeenCalled()
  })

  it('replay runs before scan (order spy)', async () => {
    const journal = createJournal()
    const layout = layoutStore()
    const replay = vi.spyOn(journal, 'replay')
    const loadStores = vi.fn(async () => {
      await layout.load()
      await journal.load()
    })
    const createWindows = vi.fn()
    const scan = vi.fn()
    const watch = vi.fn()

    await boot(
      {
        loadStores,
        replayJournal: () => replayJournal({ journal, layout, emit: vi.fn(), log: quietLog() }),
        createWindows,
        scan,
        watch
      },
      quietLog()
    )

    expect(replay).toHaveBeenCalledOnce()
    expect(loadStores).toHaveBeenCalledBefore(replay)
    expect(replay).toHaveBeenCalledBefore(createWindows)
    expect(replay).toHaveBeenCalledBefore(scan)
    expect(scan).toHaveBeenCalledBefore(watch)
  })
})
