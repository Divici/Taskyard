import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpsJournal } from '../storage/ops-journal'
import { hashPath } from '../storage/file-hash'
import { createFileOps, type FileOps, type FileOpsDeps, type FileOpsShell } from './file-ops'
import { createHarness, type Harness } from './test/harness'

let h: Harness
let journal: OpsJournal
let shell: { [K in keyof FileOpsShell]: ReturnType<typeof vi.fn> }
let ops: FileOps
let advanced: Array<[string, string]>

function build(overrides: Partial<FileOpsDeps> = {}): FileOps {
  return createFileOps({
    model: h.model,
    tracker: h.tracker,
    folders: h.folders,
    win32: h.win32,
    shell: shell as unknown as FileOpsShell,
    journal,
    log: h.log,
    ...overrides
  })
}

beforeEach(async () => {
  h = createHarness()
  journal = new OpsJournal({ path: join(h.root, 'ops.json'), log: { ...h.log } })
  await journal.load()
  advanced = []
  const advance = journal.advance.bind(journal)
  vi.spyOn(journal, 'advance').mockImplementation((token, state, details) => {
    advanced.push([token, state])
    return advance(token, state, details)
  })
  shell = {
    openPath: vi.fn(async () => ''),
    openExternal: vi.fn(async () => {}),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(async () => {})
  }
  ops = build()
})

afterEach(() => h.dispose())

async function place(name: string, content = 'x', dir = h.desktop): Promise<string> {
  writeFileSync(join(dir, name), content)
  await h.scan()
  return h.idOf(join(dir, name))
}

describe('rename', () => {
  it('renames the file, keeps its id and reports the new path once', async () => {
    const id = await place('a.txt')

    const result = await ops.rename(id, 'Budget 2024.md')

    expect(result).toEqual({ ok: true, path: join(h.desktop, 'Budget 2024.md') })
    expect(readdirSync(h.desktop)).toEqual(['Budget 2024.md'])
    expect(h.idOf(join(h.desktop, 'Budget 2024.md'))).toBe(id)
    expect(h.sink.renamed).toHaveBeenCalledExactlyOnceWith(id, join(h.desktop, 'Budget 2024.md'))
    expect(h.model.get(id)).toMatchObject({ name: 'Budget 2024', ext: '.md' })
  })

  it('an existing name is a typed "exists" error and changes nothing', async () => {
    const id = await place('a.txt', 'A')
    writeFileSync(join(h.desktop, 'b.txt'), 'B')

    expect(await ops.rename(id, 'B.TXT')).toEqual({
      ok: false,
      code: 'exists',
      message: expect.any(String)
    })
    expect(readFileSync(join(h.desktop, 'b.txt'), 'utf8')).toBe('B')
    expect(readFileSync(join(h.desktop, 'a.txt'), 'utf8')).toBe('A')
    expect(h.sink.renamed).not.toHaveBeenCalled()
  })

  it('a case-only rename goes through; the same name is a no-op', async () => {
    const id = await place('notes.txt')

    expect(await ops.rename(id, 'notes.txt')).toEqual({
      ok: true,
      path: join(h.desktop, 'notes.txt')
    })
    expect(h.sink.renamed).not.toHaveBeenCalled()
    expect(await ops.rename(id, 'Notes.TXT')).toEqual({
      ok: true,
      path: join(h.desktop, 'Notes.TXT')
    })
    expect(readdirSync(h.desktop)).toEqual(['Notes.TXT'])
  })

  it('refuses a read-only item without touching the disk', async () => {
    const id = await place('Shared.lnk', 'x', h.publicDesktop)
    h.win32.clearCalls()

    expect(await ops.rename(id, 'Mine.lnk')).toMatchObject({ ok: false, code: 'readonly' })
    expect(h.win32.callsTo('moveFile')).toEqual([])
    expect(existsSync(join(h.publicDesktop, 'Shared.lnk'))).toBe(true)
  })

  it('rejects invalid and over-long names before touching the disk', async () => {
    const id = await place('a.txt')
    h.win32.clearCalls()

    expect(await ops.rename(id, 'a:b.txt')).toMatchObject({ ok: false, code: 'invalid-name' })
    expect(await ops.rename(id, 'CON.txt')).toMatchObject({ ok: false, code: 'invalid-name' })
    expect(await ops.rename(id, `${'x'.repeat(256)}`)).toMatchObject({
      ok: false,
      code: 'name-too-long'
    })
    expect(h.win32.callsTo('moveFile')).toEqual([])
  })

  it('maps EPERM, EBUSY and ENAMETOOLONG from Windows to typed errors (never a crash)', async () => {
    const id = await place('a.txt')
    for (const [code, typed] of [
      ['EPERM', 'permission'],
      ['EACCES', 'permission'],
      ['EBUSY', 'busy'],
      ['ENAMETOOLONG', 'name-too-long'],
      ['EIO', 'failed']
    ]) {
      vi.spyOn(h.win32, 'moveFile').mockImplementationOnce(() => {
        throw Object.assign(new Error(`MoveFileExW failed (${code})`), { code })
      })
      expect(await ops.rename(id, 'b.txt'), code).toEqual({
        ok: false,
        code: typed,
        message: expect.stringContaining(code)
      })
    }
  })

  it('an unknown id is not-found', async () => {
    expect(await ops.rename('9:9', 'x.txt')).toMatchObject({ ok: false, code: 'not-found' })
  })
})

describe('trash, open, showInFolder', () => {
  it('trash sends the file to the Recycle Bin and reports the removal', async () => {
    const id = await place('a.txt')

    expect(await ops.trash(id)).toEqual({ ok: true })
    expect(shell.trashItem).toHaveBeenCalledExactlyOnceWith(join(h.desktop, 'a.txt'))
    expect(h.sink.changed).toHaveBeenCalledWith({ added: [], removed: [id], changed: [] })
  })

  it('trash refuses a read-only item and turns a failure into a typed error', async () => {
    const shared = await place('Shared.lnk', 'x', h.publicDesktop)
    expect(await ops.trash(shared)).toMatchObject({ ok: false, code: 'readonly' })
    expect(shell.trashItem).not.toHaveBeenCalled()

    const id = await place('a.txt')
    shell.trashItem.mockRejectedValueOnce(new Error('Access is denied.'))
    expect(await ops.trash(id)).toEqual({ ok: false, code: 'failed', message: 'Access is denied.' })
    expect(h.model.get(id)).toBeDefined()
  })

  it('open: .url → shell.openExternal(url), everything else → shell.openPath', async () => {
    writeFileSync(join(h.desktop, 'Site.url'), '')
    const fileId = await place('doc.pdf')
    const urlId = h.idOf(join(h.desktop, 'Site.url'))
    h.model.put({ ...h.model.get(urlId)!, url: 'https://example.com/' })

    expect(await ops.open(urlId)).toEqual({ ok: true })
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/')
    expect(await ops.open(fileId)).toEqual({ ok: true })
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(join(h.desktop, 'doc.pdf'))
  })

  it('open: a .lnk opens through the shell (its target), a folder in Explorer; never the target path directly', async () => {
    const lnkId = await place('Tool.lnk')
    mkdirSync(join(h.desktop, 'Projects'))
    await h.scan()
    const folderId = h.idOf(join(h.desktop, 'Projects'))
    // Even with a known target, the link itself is opened, so its arguments and working
    // directory apply, as they do when it is double-clicked on the Windows desktop.
    h.model.put({ ...h.model.get(lnkId)!, targetPath: 'C:\\Tools\\tool.exe' })

    expect(await ops.open(lnkId)).toEqual({ ok: true })
    expect(await ops.open(folderId)).toEqual({ ok: true })
    expect(shell.openPath.mock.calls).toEqual([
      [join(h.desktop, 'Tool.lnk')],
      [join(h.desktop, 'Projects')]
    ])
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('open: an openExternal rejection for a .url is a typed failure, not a crash', async () => {
    writeFileSync(join(h.desktop, 'Site.url'), '')
    await h.scan()
    const urlId = h.idOf(join(h.desktop, 'Site.url'))
    h.model.put({ ...h.model.get(urlId)!, url: 'https://example.com/' })
    shell.openExternal.mockRejectedValueOnce(new Error('Failed to open'))

    expect(await ops.open(urlId)).toEqual({ ok: false, code: 'failed', message: 'Failed to open' })
  })

  it('open: a .url without a URL opens the file; an openPath error string is a typed failure', async () => {
    const urlId = await place('Broken.url')
    expect(await ops.open(urlId)).toEqual({ ok: true })
    expect(shell.openPath).toHaveBeenCalledWith(join(h.desktop, 'Broken.url'))

    shell.openPath.mockResolvedValueOnce('No application is associated with this file.')
    expect(await ops.open(urlId)).toEqual({
      ok: false,
      code: 'failed',
      message: 'No application is associated with this file.'
    })
    expect(await ops.open('9:9')).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('showInFolder selects the item in Explorer', async () => {
    const id = await place('a.txt')

    expect(await ops.showInFolder(id)).toEqual({ ok: true })
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(join(h.desktop, 'a.txt'))
    expect(await ops.showInFolder('9:9')).toMatchObject({ ok: false, code: 'not-found' })
  })
})

describe('moveToDesktop', () => {
  it('same volume: moves without replacing, journal pending → done, reports id, path and token', async () => {
    writeFileSync(join(h.elsewhere, 'report.pdf'), 'R')
    const id = h.idOf(join(h.elsewhere, 'report.pdf'))

    const { moves } = await ops.moveToDesktop([join(h.elsewhere, 'report.pdf')])

    expect(moves).toEqual([
      {
        from: join(h.elsewhere, 'report.pdf'),
        ok: true,
        id,
        path: join(h.desktop, 'report.pdf'),
        token: expect.any(String)
      }
    ])
    const token = (moves[0] as { token: string }).token
    expect(journal.get(token)).toMatchObject({ state: 'done', to: join(h.desktop, 'report.pdf') })
    expect(advanced).toEqual([[token, 'done']])
    expect(h.sink.changed).toHaveBeenCalledWith({
      added: [expect.objectContaining({ id })],
      removed: [],
      changed: []
    })
  })

  it('gives a colliding name a Windows-style suffix', async () => {
    writeFileSync(join(h.desktop, 'report.pdf'), 'old')
    writeFileSync(join(h.elsewhere, 'report.pdf'), 'new')

    const { moves } = await ops.moveToDesktop([join(h.elsewhere, 'report.pdf')])

    expect(moves[0]).toMatchObject({ ok: true, path: join(h.desktop, 'report (2).pdf') })
    expect(readFileSync(join(h.desktop, 'report.pdf'), 'utf8')).toBe('old')
    expect(readFileSync(join(h.desktop, 'report (2).pdf'), 'utf8')).toBe('new')
  })

  it('cross volume: hidden partial copy → SHA-256 verified → renamed → source deleted', async () => {
    const from = join(h.elsewhere, 'photo.png')
    writeFileSync(from, 'pixels'.repeat(1000))
    const events: string[] = []
    const hash = vi.fn(async (path: string) => {
      events.push(`hash ${path.includes('.partial') ? 'partial' : 'source'}`)
      return hashPath(path)
    })
    ops = build({ sameVolume: async () => false, hash })
    const setHidden = vi.spyOn(h.win32, 'setHidden')

    const { moves } = await ops.moveToDesktop([from])

    const token = (moves[0] as { token: string }).token
    const partial = join(h.desktop, `.taskyard-${token}.partial`)
    expect(moves[0]).toMatchObject({ ok: true, path: join(h.desktop, 'photo.png') })
    expect(existsSync(from)).toBe(false)
    expect(existsSync(partial)).toBe(false)
    expect(readFileSync(join(h.desktop, 'photo.png'), 'utf8')).toBe('pixels'.repeat(1000))
    expect(setHidden.mock.calls).toEqual([
      [partial, true],
      [partial, false]
    ])
    expect(events.sort()).toEqual(['hash partial', 'hash source'])
    expect(advanced).toEqual([
      [token, 'copied'],
      [token, 'done']
    ])
    const id = h.idOf(join(h.desktop, 'photo.png'))
    expect(journal.get(token)).toMatchObject({ state: 'done', toId: id })
    expect(moves[0]).toMatchObject({ id })
  })

  it('cross volume: a hash mismatch keeps the source, deletes the copy and reports it', async () => {
    const from = join(h.elsewhere, 'photo.png')
    writeFileSync(from, 'pixels')
    ops = build({
      sameVolume: async () => false,
      hash: async (path) => (path.includes('.partial') ? 'bad' : 'good')
    })

    const { moves } = await ops.moveToDesktop([from])

    expect(moves[0]).toMatchObject({ ok: false, code: 'hash-mismatch', from })
    expect(readFileSync(from, 'utf8')).toBe('pixels')
    expect(readdirSync(h.desktop)).toEqual([])
    const [op] = journal.list()
    expect(op).toMatchObject({ state: 'undone', from })
    expect(advanced).toEqual([[op.token, 'undone']])
  })

  it('cross volume: a copy that cannot be unhidden fails the move, keeps the source and leaves nothing on the desktop', async () => {
    const from = join(h.elsewhere, 'photo.png')
    writeFileSync(from, 'pixels')
    ops = build({ sameVolume: async () => false })
    vi.spyOn(h.win32, 'setHidden').mockImplementation((_path, hidden) => hidden !== false)

    const { moves } = await ops.moveToDesktop([from])

    expect(moves[0]).toMatchObject({ ok: false, from })
    expect(moves[0]).not.toMatchObject({ ok: true })
    expect(readFileSync(from, 'utf8')).toBe('pixels')
    expect(readdirSync(h.desktop)).toEqual([])
    const [op] = journal.list()
    expect(op).toMatchObject({ state: 'undone', from })
    expect(advanced).toEqual([
      [op.token, 'copied'],
      [op.token, 'undone']
    ])
  })

  it('cross volume: moves a whole folder (tree hash)', async () => {
    const from = join(h.elsewhere, 'Album')
    mkdirSync(join(from, 'sub'), { recursive: true })
    writeFileSync(join(from, 'a.jpg'), 'a')
    writeFileSync(join(from, 'sub', 'b.jpg'), 'b')
    ops = build({ sameVolume: async () => false })

    const { moves } = await ops.moveToDesktop([from])

    expect(moves[0]).toMatchObject({ ok: true, path: join(h.desktop, 'Album') })
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(join(h.desktop, 'Album', 'sub', 'b.jpg'), 'utf8')).toBe('b')
  })

  it('an item already on a desktop is not moved (token null); a missing path is not-found', async () => {
    const id = await place('here.txt')

    const { moves } = await ops.moveToDesktop([
      join(h.desktop, 'here.txt'),
      join(h.elsewhere, 'gone.txt')
    ])

    expect(moves).toEqual([
      {
        from: join(h.desktop, 'here.txt'),
        ok: true,
        id,
        path: join(h.desktop, 'here.txt'),
        token: null
      },
      {
        from: join(h.elsewhere, 'gone.txt'),
        ok: false,
        code: 'not-found',
        message: expect.any(String)
      }
    ])
    expect(journal.list()).toEqual([])
  })

  describe('when deleting the source fails after a verified copy', () => {
    const reboot = async (): Promise<OpsJournal> => {
      const next = new OpsJournal({ path: join(h.root, 'ops.json'), log: { ...h.log } })
      await next.load()
      return next
    }

    it('a folder deleted only partly: the move stands, the op stays copied, undo waits, replay keeps both', async () => {
      const from = join(h.elsewhere, 'Album')
      mkdirSync(from)
      writeFileSync(join(from, 'a.jpg'), 'a')
      writeFileSync(join(from, 'b.jpg'), 'b')
      ops = build({
        sameVolume: async () => false,
        // rm stops half-way: a.jpg goes, b.jpg is locked.
        removeSource: async (path) => {
          rmSync(join(path, 'a.jpg'))
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
        }
      })

      const { moves } = await ops.moveToDesktop([from])

      const { token } = moves[0] as { token: string }
      expect(moves[0]).toMatchObject({ ok: true, path: join(h.desktop, 'Album') })
      expect(journal.get(token)?.state).toBe('copied')
      expect(readdirSync(join(h.desktop, 'Album')).sort()).toEqual(['a.jpg', 'b.jpg'])
      expect(readdirSync(from)).toEqual(['b.jpg'])
      expect(await ops.undoMove(token)).toMatchObject({ ok: false, code: 'failed' })
      expect(h.log.warn).toHaveBeenCalledWith(
        expect.stringContaining('could not delete the original yet'),
        expect.anything()
      )

      // Next boot: the complete copy is never deleted; the partial source is kept too.
      const report = await (await reboot()).replay()
      expect(report.finished.map((op) => op.token)).toEqual([token])
      expect(report.removedIds).toEqual([])
      expect(readdirSync(join(h.desktop, 'Album')).sort()).toEqual(['a.jpg', 'b.jpg'])
      expect(readdirSync(from)).toEqual(['b.jpg'])
    })

    it('a locked single file: the op stays copied until the next boot deletes the unchanged source', async () => {
      const from = join(h.elsewhere, 'report.pdf')
      writeFileSync(from, 'R')
      ops = build({
        sameVolume: async () => false,
        removeSource: async () => {
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
        }
      })

      const { moves } = await ops.moveToDesktop([from])

      const { token } = moves[0] as { token: string }
      expect(moves[0]).toMatchObject({ ok: true, path: join(h.desktop, 'report.pdf') })
      expect(journal.get(token)?.state).toBe('copied')
      expect(readFileSync(from, 'utf8')).toBe('R')
      expect(await ops.undoMove(token)).toMatchObject({ ok: false, code: 'failed' })

      const report = await (await reboot()).replay()
      expect(report.finished.map((op) => op.token)).toEqual([token])
      expect(existsSync(from)).toBe(false)
      expect(readFileSync(join(h.desktop, 'report.pdf'), 'utf8')).toBe('R')
    })
  })

  it('refuses a drive root or a share root before journaling or touching anything', async () => {
    const begin = vi.spyOn(journal, 'begin')
    // Safety net for this test: if the guard were missing, nothing could be copied or moved.
    ops = build({
      sameVolume: async () => {
        throw new Error('the guard should have refused first')
      }
    })
    const driveRoot = h.root.slice(0, 3) // e.g. C:\

    const { moves } = await ops.moveToDesktop([driveRoot, '\\\\server\\share'])

    expect(moves).toEqual([
      { from: driveRoot, ok: false, code: 'failed', message: expect.stringMatching(/root/) },
      {
        from: '\\\\server\\share',
        ok: false,
        code: 'failed',
        message: expect.stringMatching(/root/)
      }
    ])
    expect(begin).not.toHaveBeenCalled()
    expect(readdirSync(h.desktop)).toEqual([])
  })

  it('refuses when the Desktop itself is read-only or the journal is from a newer Taskyard', async () => {
    writeFileSync(join(h.elsewhere, 'a.txt'), '')
    const readonly = build({ folders: () => [{ path: h.desktop, readonly: true }] })
    expect((await readonly.moveToDesktop([join(h.elsewhere, 'a.txt')])).moves[0]).toMatchObject({
      ok: false,
      code: 'readonly'
    })

    vi.spyOn(journal, 'begin').mockImplementation(() => {
      throw Object.assign(new Error('ops.json is read-only'), { name: 'JournalReadOnlyError' })
    })
    expect((await ops.moveToDesktop([join(h.elsewhere, 'a.txt')])).moves[0]).toMatchObject({
      ok: false,
      code: 'journal-read-only'
    })
    expect(existsSync(join(h.elsewhere, 'a.txt'))).toBe(true)
  })
})

describe('undoMove', () => {
  it('same volume: moves the file back and closes the journal entry as undone', async () => {
    const from = join(h.elsewhere, 'report.pdf')
    writeFileSync(from, 'R')
    const { moves } = await ops.moveToDesktop([from])
    const { token, id } = moves[0] as { token: string; id: string }
    h.sink.changed.mockClear()

    expect(await ops.undoMove(token)).toEqual({ ok: true, path: from })

    expect(readFileSync(from, 'utf8')).toBe('R')
    expect(readdirSync(h.desktop)).toEqual([])
    expect(journal.get(token)?.state).toBe('undone')
    expect(h.sink.changed).toHaveBeenCalledWith({ added: [], removed: [id], changed: [] })
    // The way back is journaled like any move, so a crash during it is resolved at boot.
    expect(journal.list().filter((op) => op.token !== token)).toEqual([
      expect.objectContaining({ from: join(h.desktop, 'report.pdf'), to: from, state: 'done' })
    ])
  })

  it('cross volume: copies back with the same verification', async () => {
    const from = join(h.elsewhere, 'photo.png')
    writeFileSync(from, 'pixels')
    ops = build({ sameVolume: async () => false })
    const { moves } = await ops.moveToDesktop([from])
    const { token } = moves[0] as { token: string }

    expect(await ops.undoMove(token)).toEqual({ ok: true, path: from })
    expect(readFileSync(from, 'utf8')).toBe('pixels')
    expect(readdirSync(h.desktop)).toEqual([])
    expect(readdirSync(h.elsewhere)).toEqual(['photo.png'])
  })

  it('cross volume: a copy that cannot be unhidden fails the undo and leaves the moved file in place', async () => {
    const from = join(h.elsewhere, 'photo.png')
    writeFileSync(from, 'pixels')
    ops = build({ sameVolume: async () => false })
    const { moves } = await ops.moveToDesktop([from])
    const { token } = moves[0] as { token: string }
    vi.spyOn(h.win32, 'setHidden').mockImplementation((_path, hidden) => hidden !== false)

    const result = await ops.undoMove(token)

    expect(result).toMatchObject({ ok: false })
    expect(existsSync(from)).toBe(false)
    expect(readFileSync(join(h.desktop, 'photo.png'), 'utf8')).toBe('pixels')
    expect(readdirSync(h.desktop)).toEqual(['photo.png'])
  })

  it('refuses when the original place is taken again, or the token is unknown or not done', async () => {
    const from = join(h.elsewhere, 'a.txt')
    writeFileSync(from, 'moved')
    const { token } = (await ops.moveToDesktop([from])).moves[0] as { token: string }
    writeFileSync(from, 'someone else')

    expect(await ops.undoMove(token)).toMatchObject({ ok: false, code: 'exists' })
    expect(readFileSync(from, 'utf8')).toBe('someone else')
    expect(existsSync(join(h.desktop, 'a.txt'))).toBe(true)
    expect(journal.get(token)?.state).toBe('done')

    expect(await ops.undoMove('no-such-token')).toMatchObject({ ok: false, code: 'not-found' })
  })
})
