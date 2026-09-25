import {
  existsSync,
  mkdirSync,
  readdirSync,
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
import { JournalReadOnlyError, OpsJournal, partialPathFor } from './ops-journal'

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

/**
 * A move that journaled its verified copy (`copied`, toId = the copy's id) and died before
 * renaming it from its partial name into `to`.
 */
async function crashedBeforeRename(
  from: string,
  to: string
): Promise<{ token: string; toId: string; journal: OpsJournal }> {
  const before = createJournal()
  await before.load()
  const op = before.begin({ from, to })
  writeFileSync(partialPathFor(op), readFileSync(from))
  const toId = fileIdOf(partialPathFor(op))
  before.advance(op.token, 'copied', { toId })

  const journal = createJournal()
  await journal.load()
  return { token: op.token, toId, journal }
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

  it('replay never deletes the verified copy: an edited moved copy and its source are both kept', async () => {
    // The source delete failed (file locked), then the user edited the copy on the desktop.
    const from = join(source, 'video.mp4')
    const to = join(desktop, 'video.mp4')
    writeFileSync(from, 'the original')
    writeFileSync(to, 'the original, edited on the desktop')
    const { token, journal } = await crashedAfterCopy(from, to)

    const report = await journal.replay()

    expect(report.finished.map((op) => op.token)).toEqual([token])
    expect(report.removedIds).toEqual([])
    expect(readFileSync(to, 'utf8')).toBe('the original, edited on the desktop')
    expect(readFileSync(from, 'utf8')).toBe('the original')
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

  it('replay keeps the complete folder copy when the source was only partly deleted', async () => {
    // rm(from) failed half-way (a locked file): the source now lacks nested/b.jpg.
    const from = join(source, 'Photos')
    const to = join(desktop, 'Photos')
    mkdirSync(join(to, 'nested'), { recursive: true })
    writeFileSync(join(to, 'a.jpg'), 'aaa')
    writeFileSync(join(to, 'nested', 'b.jpg'), 'bbb')
    mkdirSync(from)
    writeFileSync(join(from, 'a.jpg'), 'aaa')
    const { journal } = await crashedAfterCopy(from, to)

    const report = await journal.replay()

    expect(report.finished).toHaveLength(1)
    expect(report.removedIds).toEqual([])
    expect(readFileSync(join(to, 'nested', 'b.jpg'), 'utf8')).toBe('bbb')
    expect(readFileSync(join(from, 'a.jpg'), 'utf8')).toBe('aaa')
  })

  it('replay leaves a foreign file at `to` alone when the copy never got there', async () => {
    const from = join(source, 'a.txt')
    const to = join(desktop, 'a.txt')
    writeFileSync(from, 'mine')
    const { token, toId, journal } = await crashedBeforeRename(from, to)
    // Later, before the next boot, some other file took the name.
    writeFileSync(to, 'someone else')

    const report = await journal.replay()

    expect(report.rolledBack.map((op) => op.token)).toEqual([token])
    expect(readFileSync(to, 'utf8')).toBe('someone else')
    expect(readFileSync(from, 'utf8')).toBe('mine')
    expect(existsSync(partialPathFor({ token, to }))).toBe(false)
    expect(report.removedIds).toEqual([toId])
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
    const setup = createJournal()
    await setup.load()
    const ids: string[] = []
    for (const { from, to } of moves) {
      writeFileSync(from, 'complete')
      const op = setup.begin({ from, to })
      writeFileSync(partialPathFor(op), 'complete')
      ids.push(fileIdOf(partialPathFor(op)))
      setup.advance(op.token, 'copied', { toId: ids.at(-1) })
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
    expect(readJournal().ops.map((op) => op.state)).toEqual(['undone', 'copied'])

    // Second boot still reports both copies.
    const journal = createJournal()
    await journal.load()
    const report = await journal.replay()

    expect(report.removedIds).toEqual(ids)
    expect(readdirSync(desktop)).toEqual([])
    expect(moves.map(({ from }) => readFileSync(from, 'utf8'))).toEqual(['complete', 'complete'])
  })

  it('replay deletes the hidden partial copy an interrupted move left in the destination folder', async () => {
    const from = join(source, 'photo.png')
    writeFileSync(from, 'pixels')
    const before = createJournal()
    await before.load()
    // Crash mid-copy (pending): only the partial exists.
    const pending = before.begin({ from, to: join(desktop, 'photo.png') })
    const pendingPartial = partialPathFor(pending)
    writeFileSync(pendingPartial, 'pix')
    // Crash after the verified copy was journaled, before its rename into place (copied).
    const other = join(source, 'other.png')
    writeFileSync(other, 'o')
    const copied = before.begin({ from: other, to: join(desktop, 'other.png') })
    const copiedPartial = partialPathFor(copied)
    mkdirSync(copiedPartial)
    writeFileSync(join(copiedPartial, 'inner'), 'o')
    before.advance(copied.token, 'copied', { toId: fileIdOf(copiedPartial) })

    const journal = createJournal()
    await journal.load()
    const report = await journal.replay()

    expect(existsSync(pendingPartial)).toBe(false)
    expect(existsSync(copiedPartial)).toBe(false)
    expect(readFileSync(from, 'utf8')).toBe('pixels')
    expect(readFileSync(other, 'utf8')).toBe('o')
    expect(report.rolledBack.map((op) => op.token).sort()).toEqual(
      [pending.token, copied.token].sort()
    )
    expect(partialPathFor(pending)).toBe(join(desktop, `.taskyard-${pending.token}.partial`))
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
    const { toId, journal } = await crashedBeforeRename(from, to)
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
    const { toId, journal } = await crashedBeforeRename(from, to)
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
