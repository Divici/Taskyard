import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopIcon } from '@shared/ipc'
import { splitItemName } from '@shared/item-name'
import type { DesktopItem } from '@shared/schema'
import type { IconBitmap } from '../win32/api'
import { DRIVE_REMOTE, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS } from '../win32/constants'
import { createFakeWin32Api, type FakeWin32Api } from '../win32/fake-api'
import { systemFolderIcon } from './icon-plan'
import { createIconService, iconCacheKey, type IconFs, type IconService } from './icon-service'

const SYSTEM_ROOT = 'C:\\Windows'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A tiny "PNG": the real signature, then a label naming what it was made from. */
const png = (label: string): Buffer => Buffer.concat([PNG_SIGNATURE, Buffer.from(label)])
const dataUrl = (bytes: Buffer): string => `data:image/png;base64,${bytes.toString('base64')}`
const bitmap = (px: number): IconBitmap => ({
  width: px,
  height: px,
  bgra: Buffer.alloc(px * px * 4),
  mask: null
})

let root: string
let cacheDir: string
let desktop: string
let win32: FakeWin32Api
let fs: { [K in keyof IconFs]: ReturnType<typeof vi.fn> & IconFs[K] }
let getFileIcon: ReturnType<typeof vi.fn<(path: string) => Promise<Buffer>>>
let scale: number[]
/** Every desktop:icon payload as sent, and the same without its version (most tests). */
let sent: DesktopIcon[]
let emitted: Array<Omit<DesktopIcon, 'version'>>
let log: {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}
const services: IconService[] = []

function item(fileName: string, fields: Partial<DesktopItem> = {}): DesktopItem {
  const kind = fields.kind ?? 'file'
  return {
    id: `7:${createHash('sha1').update(fileName).digest().readUInt32BE(0)}`,
    path: join(desktop, fileName),
    ...splitItemName(fileName, kind),
    kind,
    mtimeMs: 1_700_000_000_000,
    sizeBytes: 1234,
    readonly: false,
    placeholder: false,
    ...fields
  }
}

const app = (name = 'tool.exe', fields: Partial<DesktopItem> = {}): DesktopItem =>
  item(name, { kind: 'app', ext: '.exe', ...fields })

function createService(
  overrides: Partial<Parameters<typeof createIconService>[0]> = {}
): IconService {
  const service = createIconService({
    cacheDir,
    fs,
    win32,
    getFileIcon,
    encodePng: (icon) => png(`extracted ${icon.width}`),
    scaleFactors: () => scale,
    emit: (_event, payload) => {
      sent.push(payload)
      emitted.push({ id: payload.id, px: payload.px, dataUrl: payload.dataUrl })
    },
    log,
    systemRoot: SYSTEM_ROOT,
    ...overrides
  })
  services.push(service)
  return service
}

async function run(service: IconService, ...items: DesktopItem[]): Promise<void> {
  service.update({ added: items, removed: [], changed: [] })
  await service.idle()
}

const cacheFile = (entry: DesktopItem, px: number): string =>
  join(cacheDir, `${iconCacheKey(entry)}@${px}.png`)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'taskyard-icons-'))
  cacheDir = join(root, 'userData', 'icons')
  desktop = join(root, 'Desktop')
  mkdirSync(desktop)
  win32 = createFakeWin32Api()
  // Real file system calls on the temp folder, each one spied on.
  fs = {
    readFile: vi.fn((path: string) => fsp.readFile(path)),
    writeFile: vi.fn((path: string, data: Buffer) => fsp.writeFile(path, data)),
    rename: vi.fn((from: string, to: string) => fsp.rename(from, to)),
    mkdir: vi.fn((path: string) => fsp.mkdir(path, { recursive: true })),
    readdir: vi.fn((path: string) => fsp.readdir(path)),
    unlink: vi.fn((path: string) => fsp.unlink(path)),
    stat: vi.fn((path: string) => fsp.stat(path))
  } as unknown as typeof fs
  getFileIcon = vi.fn(async (path: string) => png(`shell ${path}`))
  scale = [1, 1.5]
  emitted = []
  sent = []
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
})

afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('icon service: the pipeline', () => {
  it('streams Electron’s 32 px icon first, then the display-size icon, as desktop:icon {id, px, dataUrl}', async () => {
    const tool = app()
    win32.setIcon(tool.path, 0, 96, bitmap(96))
    const service = createService()

    await run(service, tool)

    expect(getFileIcon).toHaveBeenCalledWith(tool.path)
    expect(win32.callsTo('extractIcon')).toEqual([[tool.path, 0, 96]])
    expect(emitted).toEqual([
      { id: tool.id, px: 32, dataUrl: dataUrl(png(`shell ${tool.path}`)) },
      { id: tool.id, px: 96, dataUrl: dataUrl(png('extracted 96')) }
    ])
    expect(service.list()).toEqual([sent[1]])
    // Both sizes of one version of the item carry the same version.
    expect(sent[0].version).toBe(sent[1].version)
  })

  it('caches each size on disk as <sha1(id|mtime|size)>@<px>.png', async () => {
    const tool = app()
    win32.setIcon(tool.path, 0, 96, bitmap(96))

    await run(createService(), tool)

    const key = createHash('sha1')
      .update(`${tool.id}|${tool.mtimeMs}|${tool.sizeBytes}`)
      .digest('hex')
    expect(iconCacheKey(tool)).toBe(key)
    expect(readdirSync(cacheDir).sort()).toEqual([`${key}@32.png`, `${key}@96.png`])
  })

  it('cache hit skips extraction: a new session sends the cached display-size icon only', async () => {
    const tool = app()
    win32.setIcon(tool.path, 0, 96, bitmap(96))
    await run(createService(), tool)
    getFileIcon.mockClear()
    win32.clearCalls()
    emitted = []

    await run(createService(), tool)

    expect(getFileIcon).not.toHaveBeenCalled()
    expect(win32.callsTo('extractIcon')).toEqual([])
    expect(emitted).toEqual([{ id: tool.id, px: 96, dataUrl: dataUrl(png('extracted 96')) }])
  })

  it('a changed file (new mtime or size) misses the cache and is extracted again', async () => {
    const tool = app()
    win32.setIcon(tool.path, 0, 96, bitmap(96))
    const service = createService()
    await run(service, tool)
    win32.clearCalls()

    service.update({ added: [], removed: [], changed: [{ ...tool, mtimeMs: tool.mtimeMs + 5 }] })
    await service.idle()

    expect(win32.callsTo('extractIcon')).toEqual([[tool.path, 0, 96]])
  })

  it('does not send an unchanged item again (a rescan re-lists everything)', async () => {
    const tool = app()
    win32.setIcon(tool.path, 0, 96, bitmap(96))
    const service = createService()
    await run(service, tool)
    emitted = []

    await run(service, tool)

    expect(emitted).toEqual([])
  })

  it('a corrupt cache file is a miss: the icon is extracted again and the file rewritten', async () => {
    const tool = app()
    win32.setIcon(tool.path, 0, 96, bitmap(96))
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cacheFile(tool, 96), 'not a png')

    await run(createService(), tool)

    expect(win32.callsTo('extractIcon')).toEqual([[tool.path, 0, 96]])
    expect(emitted.at(-1)).toEqual({ id: tool.id, px: 96, dataUrl: dataUrl(png('extracted 96')) })
    expect((await fsp.readFile(cacheFile(tool, 96))).subarray(0, 8)).toEqual(PNG_SIGNATURE)
  })

  it('runs at most 4 icon jobs at once', async () => {
    let running = 0
    let peak = 0
    getFileIcon.mockImplementation(async (path) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running--
      return png(path)
    })
    const items = Array.from({ length: 12 }, (_, i) => item(`doc ${i}.txt`, { ext: '.txt' }))

    await run(createService(), ...items)

    expect(getFileIcon).toHaveBeenCalledTimes(12)
    expect(peak).toBe(4)
  })

  it('sends every item’s 32 px icon before any extraction starts', async () => {
    const tools = [app('a.exe'), app('b.exe'), app('c.exe'), app('d.exe'), app('e.exe')]
    for (const tool of tools) win32.setIcon(tool.path, 0, 96, bitmap(96))

    await run(createService(), ...tools)

    expect(emitted.map((icon) => icon.px)).toEqual([32, 32, 32, 32, 32, 96, 96, 96, 96, 96])
  })
})

describe('icon service: px follows the displays', () => {
  it('extracts at ceil(64 × the largest scale factor): 96 px at 150 %', async () => {
    const tool = app()
    win32.setIcon(tool.path, 0, 96, bitmap(96))
    const service = createService()

    await run(service, tool)

    expect(service.px).toBe(96)
    expect(win32.callsTo('extractIcon')).toEqual([[tool.path, 0, 96]])
  })

  it('re-extracts at the new size when the largest scale factor grows, never when it shrinks', async () => {
    scale = [1]
    const tool = app()
    const doc = item('notes.txt', { ext: '.txt' })
    win32.setIcon(tool.path, 0, 64, bitmap(64))
    win32.setIcon(tool.path, 0, 128, bitmap(128))
    const service = createService()
    await run(service, tool, doc)
    expect(win32.callsTo('extractIcon')).toEqual([[tool.path, 0, 64]])
    win32.clearCalls()
    getFileIcon.mockClear()
    emitted = []

    scale = [1, 2]
    service.refreshScale()
    await service.idle()

    expect(service.px).toBe(128)
    expect(win32.callsTo('extractIcon')).toEqual([[tool.path, 0, 128]])
    expect(getFileIcon).not.toHaveBeenCalled()
    expect(emitted).toEqual([{ id: tool.id, px: 128, dataUrl: dataUrl(png('extracted 128')) }])
    win32.clearCalls()
    emitted = []

    scale = [1]
    service.refreshScale()
    await service.idle()

    expect(service.px).toBe(128)
    expect(win32.callsTo('extractIcon')).toEqual([])
    expect(emitted).toEqual([])
  })
})

describe('icon service: never reads what it must not', () => {
  it('placeholder → generic without any fs read (no cache, no stat, no attributes, no icon calls)', async () => {
    const cloud = [
      app('cloud.exe', { placeholder: true }),
      item('cloud.docx', { ext: '.docx', placeholder: true }),
      item('Cloud folder', { kind: 'folder', placeholder: true }),
      item('cloud.lnk', { kind: 'link', ext: '.lnk', placeholder: true })
    ]
    const service = createService()

    await run(service, ...cloud)

    for (const call of Object.values(fs)) expect(call).not.toHaveBeenCalled()
    expect(getFileIcon).not.toHaveBeenCalled()
    expect(win32.calls).toEqual([])
    expect(emitted).toEqual([])
    expect(service.list()).toEqual([])
  })

  it('a shortcut to a UNC or mapped network target → generic without any read', async () => {
    const remote = item('share.lnk', {
      kind: 'link',
      ext: '.lnk',
      targetPath: '\\\\server\\share\\app.exe',
      targetRemote: true,
      iconPath: '\\\\server\\share\\app.exe'
    })
    const mapped = item('mapped.lnk', {
      kind: 'link',
      ext: '.lnk',
      targetPath: 'Z:\\app.exe',
      targetRemote: true
    })

    await run(createService(), remote, mapped)

    for (const call of Object.values(fs)) expect(call).not.toHaveBeenCalled()
    expect(getFileIcon).not.toHaveBeenCalled()
    expect(win32.calls).toEqual([])
    expect(emitted).toEqual([])
  })

  it('never opens a cloud-placeholder icon file a local shortcut points at', async () => {
    const target = join(root, 'OneDrive', 'app.exe')
    win32.setFileAttributes(target, FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)
    const link = item('app.lnk', {
      kind: 'link',
      ext: '.lnk',
      targetPath: target,
      targetRemote: false
    })

    await run(createService(), link)

    expect(getFileIcon).not.toHaveBeenCalled()
    expect(win32.callsTo('extractIcon')).toEqual([])
    expect(emitted).toEqual([])
  })
})

describe('icon service: kinds', () => {
  it('a shortcut shows its target’s icon (Electron draws every .lnk the same)', async () => {
    const target = 'C:\\Program Files\\App\\app.exe'
    const link = item('App.lnk', {
      kind: 'link',
      ext: '.lnk',
      targetPath: target,
      targetRemote: false
    })
    win32.setIcon(target, 0, 96, bitmap(96))

    await run(createService(), link)

    expect(getFileIcon).toHaveBeenCalledWith(target)
    expect(getFileIcon).not.toHaveBeenCalledWith(link.path)
    expect(win32.callsTo('extractIcon')).toEqual([[target, 0, 96]])
    expect(emitted.map((icon) => icon.px)).toEqual([32, 96])
  })

  it('a folder gets the Windows folder icon at the display size', async () => {
    const folder = item('Projects', { kind: 'folder' })
    const { file, index } = systemFolderIcon(SYSTEM_ROOT)
    win32.setIcon(file, index, 96, bitmap(96))

    await run(createService(), folder)

    expect(getFileIcon).not.toHaveBeenCalled()
    expect(emitted).toEqual([{ id: folder.id, px: 96, dataUrl: dataUrl(png('extracted 96')) }])
  })

  it('a shortcut to a folder gets the folder icon; to a file without an extension, its 32 px', async () => {
    const targetFolder = join(root, 'Target folder')
    mkdirSync(targetFolder)
    const targetFile = join(root, 'Makefile')
    writeFileSync(targetFile, 'all:')
    const toFolder = item('Folder.lnk', { kind: 'link', ext: '.lnk', targetPath: targetFolder })
    const toFile = item('Make.lnk', { kind: 'link', ext: '.lnk', targetPath: targetFile })
    const { file, index } = systemFolderIcon(SYSTEM_ROOT)
    win32.setIcon(file, index, 96, bitmap(96))

    await run(createService(), toFolder, toFile)

    expect(emitted).toContainEqual({
      id: toFolder.id,
      px: 96,
      dataUrl: dataUrl(png('extracted 96'))
    })
    expect(emitted).toContainEqual({
      id: toFile.id,
      px: 32,
      dataUrl: dataUrl(png(`shell ${targetFile}`))
    })
    expect(getFileIcon).toHaveBeenCalledTimes(1)
  })
})

describe('icon service: failures', () => {
  it('failure → generic: nothing is sent or cached, it is logged once, and other items go on', async () => {
    const broken = app('broken.exe')
    const good = item('notes.txt', { ext: '.txt' })
    getFileIcon.mockImplementation(async (path) => {
      if (path === broken.path) throw new Error('Failed to get file icon')
      return png(path)
    })
    vi.spyOn(win32, 'extractIcon').mockImplementation(() => {
      throw new Error('PrivateExtractIconsW found no icon')
    })
    const service = createService()

    await run(service, broken, good)

    expect(emitted.map((icon) => icon.id)).toEqual([good.id])
    expect(service.list().map((icon) => icon.id)).toEqual([good.id])
    expect(existsSync(cacheFile(broken, 32))).toBe(false)
    expect(existsSync(cacheFile(broken, 96))).toBe(false)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toBe(
      `icons: broken.exe has no icon (Failed to get file icon; PrivateExtractIconsW found no icon), the generic one is shown`
    )
  })

  it('keeps the 32 px icon when extraction finds nothing', async () => {
    const tool = app()

    await run(createService(), tool)

    expect(win32.callsTo('extractIcon')).toEqual([[tool.path, 0, 96]])
    expect(emitted.map((icon) => icon.px)).toEqual([32])
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('still sends an icon when the disk cache cannot be written', async () => {
    const tool = app()
    fs.writeFile.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))

    await run(createService(), tool)

    expect(emitted.map((icon) => icon.px)).toEqual([32])
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^icons: caching .*@32\.png failed/),
      expect.anything()
    )
  })
})

describe('icon service: lifecycle', () => {
  it('forgets removed items and sends nothing for them afterwards', async () => {
    const tool = app()
    let release: () => void = () => {}
    getFileIcon.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(png('late'))))
    )
    const service = createService()
    service.update({ added: [tool], removed: [], changed: [] })
    await vi.waitFor(() => expect(getFileIcon).toHaveBeenCalled())

    service.update({ added: [], removed: [tool.id], changed: [] })
    release()
    await service.idle()

    expect(emitted).toEqual([])
    expect(service.list()).toEqual([])
  })

  it('re-resolves a renamed item whose extension changed', async () => {
    const doc = item('notes.txt', { ext: '.txt' })
    const service = createService()
    await run(service, doc)
    getFileIcon.mockClear()

    const renamed = join(desktop, 'notes.md')
    service.renamed(doc.id, renamed)
    await service.idle()

    expect(getFileIcon).toHaveBeenCalledWith(renamed)
    expect(emitted.at(-1)).toEqual({
      id: doc.id,
      px: 32,
      dataUrl: dataUrl(png(`shell ${renamed}`))
    })
  })

  it('keeps the icon of a renamed item whose extension did not change', async () => {
    const doc = item('notes.txt', { ext: '.txt' })
    const service = createService()
    await run(service, doc)
    getFileIcon.mockClear()
    emitted = []

    service.renamed(doc.id, join(desktop, 'ideas.txt'))
    await service.idle()

    expect(getFileIcon).not.toHaveBeenCalled()
    expect(emitted).toEqual([])
  })

  it('prunes the cached icons of items that are gone (after the boot pass)', async () => {
    const gone = app('gone.exe')
    const kept = app('kept.exe')
    win32.setIcon(gone.path, 0, 96, bitmap(96))
    win32.setIcon(kept.path, 0, 96, bitmap(96))
    await run(createService(), gone, kept)
    writeFileSync(join(cacheDir, 'unrelated.txt'), 'x')

    const service = createService()
    await run(service, kept)
    await service.prune()

    expect(readdirSync(cacheDir).sort()).toEqual(
      [`${iconCacheKey(kept)}@32.png`, `${iconCacheKey(kept)}@96.png`, 'unrelated.txt'].sort()
    )
  })

  it('sends nothing after stop', async () => {
    const tool = app()
    let release: () => void = () => {}
    getFileIcon.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(png('late'))))
    )
    const service = createService()
    service.update({ added: [tool], removed: [], changed: [] })
    await vi.waitFor(() => expect(getFileIcon).toHaveBeenCalled())

    service.stop()
    release()
    await service.idle()

    expect(emitted).toEqual([])
    service.update({ added: [app('late.exe')], removed: [], changed: [] })
    await service.idle()
    expect(emitted).toEqual([])
  })
})

describe('icon service: stale icons are replaced or cleared (review fix)', () => {
  it('an .exe renamed to .txt gets the text icon under a new version (same id, mtime and size)', async () => {
    const tool = app()
    win32.setIcon(tool.path, 0, 96, bitmap(96))
    const service = createService()
    await run(service, tool)
    const before = sent.at(-1)!

    const renamed = join(desktop, 'tool.txt')
    service.renamed(tool.id, renamed)
    await service.idle()

    const after = sent.at(-1)!
    expect(after).toMatchObject({ id: tool.id, px: 32, dataUrl: dataUrl(png(`shell ${renamed}`)) })
    expect(after.version).not.toBe(before.version)
    expect(service.list()).toEqual([after])
  })

  it('a shortcut retargeted from an exe to a pdf gets a new version', async () => {
    const link = item('Report.lnk', {
      kind: 'link',
      targetPath: 'C:\\apps\\report.exe',
      targetRemote: false
    })
    win32.setIcon('C:\\apps\\report.exe', 0, 96, bitmap(96))
    const service = createService()
    await run(service, link)
    const before = sent.at(-1)!

    const retargeted = { ...link, targetPath: 'D:\\docs\\report.pdf', mtimeMs: link.mtimeMs + 1 }
    service.update({ added: [], removed: [], changed: [retargeted] })
    await service.idle()

    const after = sent.at(-1)!
    expect(after).toMatchObject({ px: 32, dataUrl: dataUrl(png('shell D:\\docs\\report.pdf')) })
    expect(after.version).not.toBe(before.version)
  })

  it('an item that turns into a placeholder is cleared (dataUrl null) without any read', async () => {
    const doc = item('notes.txt')
    const service = createService()
    await run(service, doc)
    getFileIcon.mockClear()
    win32.clearCalls()
    for (const call of Object.values(fs)) call.mockClear()

    service.update({ added: [], removed: [], changed: [{ ...doc, placeholder: true, mtimeMs: 5 }] })
    await service.idle()

    expect(sent.at(-1)).toEqual({ id: doc.id, px: 0, dataUrl: null, version: expect.any(String) })
    expect(service.list()).toEqual([])
    expect(getFileIcon).not.toHaveBeenCalled()
    expect(win32.calls).toEqual([])
    for (const call of Object.values(fs)) expect(call).not.toHaveBeenCalled()
  })

  it('a changed item whose new icon cannot be made is cleared, not left with the old one', async () => {
    const doc = item('notes.txt')
    const service = createService()
    await run(service, doc)
    getFileIcon.mockRejectedValue(new Error('Failed to get file icon'))

    service.update({ added: [], removed: [], changed: [{ ...doc, mtimeMs: 9 }] })
    await service.idle()

    expect(sent.at(-1)).toMatchObject({ id: doc.id, px: 0, dataUrl: null })
    expect(service.list()).toEqual([])
  })

  it('never clears an item that never had an icon', async () => {
    await run(createService(), item('cloud.txt', { placeholder: true }))
    expect(sent).toEqual([])
  })
})

describe('icon service: mapped network drives (review fix)', () => {
  it('never reads an icon source on a mapped network drive; asks the drive type once per letter', async () => {
    win32.setDriveType('Z:\\', DRIVE_REMOTE)
    const links = ['a', 'b'].map((name) =>
      item(`${name}.lnk`, {
        kind: 'link',
        targetPath: `Z:\\apps\\${name}.exe`,
        targetRemote: false
      })
    )
    const game = item('Game.url', { kind: 'url', iconPath: 'z:\\games\\game.ico', iconIndex: 0 })

    await run(createService(), ...links, game)

    expect(win32.callsTo('getDriveType')).toEqual([['Z:\\']])
    expect(win32.callsTo('extractIcon')).toEqual([])
    expect(win32.callsTo('getFileAttributes')).toEqual([])
    expect(getFileIcon.mock.calls).toEqual([[game.path]]) // the .url itself, on the local desktop
    expect(sent.map((icon) => icon.id)).toEqual([game.id])
  })

  it('reads sources on local drives as before', async () => {
    const target = 'D:\\Games\\Steam\\Steam.exe'
    win32.setIcon(target, 0, 96, bitmap(96))
    const link = item('Steam.lnk', { kind: 'link', targetPath: target, targetRemote: false })

    await run(createService(), link)

    expect(win32.callsTo('getDriveType')).toEqual([['D:\\']])
    expect(emitted.map((icon) => icon.px)).toEqual([32, 96])
  })
})
