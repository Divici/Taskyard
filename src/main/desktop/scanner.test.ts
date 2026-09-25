import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_ATTRIBUTE_HIDDEN,
  FILE_ATTRIBUTE_OFFLINE,
  FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
  FILE_ATTRIBUTE_SYSTEM
} from '../win32/constants'
import { createFakeWin32Api, type FakeWin32Api } from '../win32/fake-api'
import { describeScan, readDesktopItem, scanDesktop, type ScanDeps } from './scanner'
import type { ShortcutInfo } from './shortcuts'

let root: string
let user: string
let pub: string
let win32: FakeWin32Api
let readShortcut: ReturnType<
  typeof vi.fn<(path: string, kind: 'link' | 'url') => Promise<ShortcutInfo>>
>
const log = { info: vi.fn(), warn: vi.fn() }

function deps(): ScanDeps {
  return { win32, readShortcut, log }
}

function idOf(path: string): string {
  const stats = statSync(path, { bigint: true })
  return `${stats.dev}:${stats.ino}`
}

beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'taskyard-scan-'))
  user = join(root, 'Desktop')
  pub = join(root, 'Public Desktop')
  mkdirSync(user)
  mkdirSync(pub)
  win32 = createFakeWin32Api()
  readShortcut = vi.fn(async (path: string, kind: 'link' | 'url') =>
    kind === 'url'
      ? { url: `https://example.com/${path.length}` }
      : { targetPath: 'C:\\Tools\\tool.exe', targetRemote: false, iconIndex: 0 }
  )
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scanDesktop', () => {
  it('lists every item with id `${dev}:${ino}` from a bigint stat, kind, name, size and mtime', async () => {
    writeFileSync(join(user, 'Budget.xlsx'), 'x'.repeat(2048))
    utimesSync(join(user, 'Budget.xlsx'), 1_700_000_000, 1_700_000_000)
    mkdirSync(join(user, 'Projects.2024'))
    writeFileSync(join(user, 'setup.exe'), 'MZ')

    const { items } = await scanDesktop([user], deps())

    const byName = Object.fromEntries(items.map((item) => [item.name, item]))
    expect(byName['Budget']).toEqual({
      id: idOf(join(user, 'Budget.xlsx')),
      path: join(user, 'Budget.xlsx'),
      name: 'Budget',
      ext: '.xlsx',
      kind: 'file',
      mtimeMs: 1_700_000_000_000,
      sizeBytes: 2048,
      readonly: false,
      placeholder: false
    })
    expect(byName['Budget'].id).toMatch(/^\d+:\d+$/)
    expect(byName['Projects.2024']).toMatchObject({ kind: 'folder', ext: '', sizeBytes: 0 })
    expect(byName['setup']).toMatchObject({ kind: 'app', ext: '.exe' })
  })

  it('skips hidden and system items (desktop.ini) through the file attributes', async () => {
    writeFileSync(join(user, 'desktop.ini'), '[.ShellClassInfo]')
    writeFileSync(join(user, 'secret.txt'), '')
    writeFileSync(join(user, 'thumbs.db'), '')
    writeFileSync(join(user, 'visible.txt'), '')
    win32.setFileAttributes(
      join(user, 'desktop.ini'),
      FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM
    )
    win32.setFileAttributes(join(user, 'secret.txt'), FILE_ATTRIBUTE_HIDDEN)
    win32.setFileAttributes(join(user, 'thumbs.db'), FILE_ATTRIBUTE_SYSTEM)
    win32.setFileAttributes(join(user, 'visible.txt'), 0x20)

    const { items } = await scanDesktop([user], deps())

    expect(items.map((item) => item.name)).toEqual(['visible'])
  })

  it('flags OneDrive placeholders (RECALL_ON_DATA_ACCESS or OFFLINE) and never reads them', async () => {
    writeFileSync(join(user, 'cloud.lnk'), 'not read')
    writeFileSync(join(user, 'offline.url'), 'not read')
    writeFileSync(join(user, 'local.lnk'), 'x')
    win32.setFileAttributes(join(user, 'cloud.lnk'), FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | 0x20)
    win32.setFileAttributes(join(user, 'offline.url'), FILE_ATTRIBUTE_OFFLINE)

    const report = await scanDesktop([user], deps())

    const byName = Object.fromEntries(report.items.map((item) => [item.name, item]))
    expect(byName['cloud']).toMatchObject({ kind: 'link', placeholder: true })
    expect(byName['cloud'].targetPath).toBeUndefined()
    expect(byName['offline']).toMatchObject({ kind: 'url', placeholder: true })
    expect(byName['local']).toMatchObject({ placeholder: false, targetPath: 'C:\\Tools\\tool.exe' })
    expect(readShortcut).toHaveBeenCalledExactlyOnceWith(join(user, 'local.lnk'), 'link')
    expect(report.placeholderCount).toBe(2)
  })

  it('flags every item of a folder Windows will not let us modify as readonly', async () => {
    writeFileSync(join(user, 'mine.txt'), '')
    writeFileSync(join(pub, 'Shared App.lnk'), '')
    win32.setFolderWritable(pub, false)

    const report = await scanDesktop([user, pub], deps())

    expect(report.items.map((item) => [item.name, item.readonly])).toEqual([
      ['mine', false],
      ['Shared App', true]
    ])
    expect(report.folders).toEqual([
      { path: user, readonly: false, count: 1 },
      { path: pub, readonly: true, count: 1 }
    ])
    expect(report.readonlyCount).toBe(1)
    expect(win32.callsTo('canModifyFolder')).toEqual([[user], [pub]])
  })

  it('merges shortcut details for .lnk and .url', async () => {
    writeFileSync(join(user, 'Tool.lnk'), '')
    writeFileSync(join(user, 'Site.url'), '')

    const { items } = await scanDesktop([user], deps())

    expect(items.find((item) => item.kind === 'link')).toMatchObject({
      targetPath: 'C:\\Tools\\tool.exe',
      targetRemote: false,
      iconIndex: 0
    })
    expect(items.find((item) => item.kind === 'url')?.url).toMatch(/^https:\/\/example\.com\//)
  })

  it('never lists the temporary copy of an unfinished move', async () => {
    writeFileSync(join(user, '.taskyard-1234.partial'), '')

    expect((await scanDesktop([user], deps())).items).toEqual([])
  })

  it('reports a missing folder and still scans the others', async () => {
    writeFileSync(join(pub, 'a.txt'), '')
    const missing = join(root, 'Gone')

    const report = await scanDesktop([missing, pub], deps())

    expect(report.items.map((item) => item.name)).toEqual(['a'])
    expect(report.folders[0]).toMatchObject({ path: missing, count: 0, error: expect.any(String) })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(`scan: cannot read ${missing}`))
  })

  it('keeps one item per file id (a hard link listed twice is shown once)', async () => {
    writeFileSync(join(user, 'a.txt'), 'x')
    linkSync(join(user, 'a.txt'), join(user, 'b.txt'))

    const { items } = await scanDesktop([user], deps())

    expect(items).toHaveLength(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('same file id'))
  })

  it('treats unreadable attributes as an ordinary item', async () => {
    writeFileSync(join(user, 'a.txt'), '')

    expect((await scanDesktop([user], deps())).items).toHaveLength(1)
    expect(win32.getFileAttributes(join(user, 'a.txt'))).toBeNull()
  })

  it('sorts items by folder, then name, so the list is stable', async () => {
    for (const name of ['b.txt', 'A.txt', 'c.txt']) writeFileSync(join(user, name), '')

    const { items } = await scanDesktop([user], deps())

    expect(items.map((item) => item.name)).toEqual(['A', 'b', 'c'])
  })
})

describe('readDesktopItem', () => {
  it('returns null for a path that vanished, a hidden file or a partial copy', async () => {
    writeFileSync(join(user, 'h.txt'), '')
    win32.setFileAttributes(join(user, 'h.txt'), FILE_ATTRIBUTE_HIDDEN)

    const folder = { path: user, readonly: false }
    expect(await readDesktopItem(join(user, 'gone.txt'), folder, deps())).toBeNull()
    expect(await readDesktopItem(join(user, 'h.txt'), folder, deps())).toBeNull()
    expect(await readDesktopItem(join(user, '.taskyard-x.partial'), folder, deps())).toBeNull()
  })
})

describe('describeScan', () => {
  it('formats the boot log line', () => {
    expect(
      describeScan({ items: new Array(61), ms: 84.6, readonlyCount: 11, placeholderCount: 0 })
    ).toBe('scan: 61 items in 85 ms (11 readonly, 0 placeholders)')
  })
})
