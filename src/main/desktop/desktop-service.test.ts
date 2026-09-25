import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLayout } from '@shared/defaults'
import type { DesktopChange, DesktopRenamed } from '@shared/ipc'
import type { LayoutFile } from '@shared/schema'
import { OpsJournal } from '../storage/ops-journal'
import { createFakeWin32Api, type FakeWin32Api } from '../win32/fake-api'
import { createDesktopService, type DesktopService } from './desktop-service'

let root: string
let desktop: string
let publicDesktop: string
let win32: FakeWin32Api
let layoutData: LayoutFile
let layout: { get: () => LayoutFile; save: ReturnType<typeof vi.fn> }
let emitted: Array<[string, unknown]>
let log: {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}
let service: DesktopService
let journal: OpsJournal

const idOf = (path: string): string => {
  const stats = statSync(path, { bigint: true })
  return `${stats.dev}:${stats.ino}`
}
const events = <T>(name: string): T[] =>
  emitted.filter(([event]) => event === name).map(([, payload]) => payload as T)

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function create(): DesktopService {
  return createDesktopService({
    dirs: [desktop, publicDesktop],
    win32,
    shell: {
      openPath: vi.fn(async () => ''),
      openExternal: vi.fn(async () => {}),
      showItemInFolder: vi.fn(),
      trashItem: vi.fn(async () => {})
    },
    journal,
    layout,
    emit: (event, payload) => {
      emitted.push([event, payload])
      return 1
    },
    env: {},
    log
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'taskyard-service-'))
  desktop = join(root, 'Desktop')
  publicDesktop = join(root, 'Public')
  mkdirSync(desktop)
  mkdirSync(publicDesktop)
  win32 = createFakeWin32Api()
  win32.setFolderWritable(publicDesktop, false)
  layoutData = emptyLayout()
  layout = {
    get: () => layoutData,
    save: vi.fn((next: LayoutFile) => {
      layoutData = next
      return { ok: true, revision: layout.save.mock.calls.length + 1 }
    })
  }
  emitted = []
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  journal = new OpsJournal({ path: join(root, 'ops.json'), log: { ...log } })
  await journal.load()
})

afterEach(async () => {
  await service?.stop()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('desktop service', () => {
  it('scan: emits the full list once, logs the boot line, and serves desktop:list', async () => {
    writeFileSync(join(desktop, 'a.txt'), '')
    mkdirSync(join(desktop, 'Folder'))
    writeFileSync(
      join(publicDesktop, 'Shared.url'),
      '[InternetShortcut]\r\nURL=https://x.example/\r\n'
    )
    service = create()

    const listed = service.list() // asked before the scan: waits for it
    const report = await service.scan()

    expect(report.items).toHaveLength(3)
    expect(await listed).toEqual(report.items)
    expect(events<DesktopChange>('desktop:changed')).toEqual([
      { added: report.items, removed: [], changed: [] }
    ])
    expect(log.info).toHaveBeenCalledWith(
      expect.stringMatching(/^scan: 3 items in \d+ ms \(1 readonly, 0 placeholders\)$/)
    )
    expect(log.info).toHaveBeenCalledWith(`scan: folder ${publicDesktop} read-only, 1 item(s)`)
    expect(log.info).toHaveBeenCalledWith(`scan: folder ${desktop} writable, 2 item(s)`)
    expect(report.items.find((item) => item.kind === 'url')?.url).toBe('https://x.example/')
  })

  it('scan: brings paths[id] up to date for files renamed while Taskyard was closed (one save)', async () => {
    writeFileSync(join(desktop, 'new name.txt'), '')
    writeFileSync(join(desktop, 'same.txt'), '')
    const renamed = idOf(join(desktop, 'new name.txt'))
    const same = idOf(join(desktop, 'same.txt'))
    layoutData = {
      ...emptyLayout(),
      paths: { [renamed]: join(desktop, 'old name.txt'), [same]: join(desktop, 'same.txt') }
    }
    service = create()

    await service.scan()

    expect(layout.save).toHaveBeenCalledOnce()
    expect(layoutData.paths).toEqual({
      [renamed]: join(desktop, 'new name.txt'),
      [same]: join(desktop, 'same.txt')
    })
  })

  it('rename through Taskyard: one desktop:renamed and one paths[id] update, even after the watcher sees it', async () => {
    writeFileSync(join(desktop, 'a.txt'), '')
    const id = idOf(join(desktop, 'a.txt'))
    layoutData = { ...emptyLayout(), paths: { [id]: join(desktop, 'a.txt') } }
    service = create()
    await service.scan()
    await service.watch()

    expect(await service.rename(id, 'b.txt')).toEqual({ ok: true, path: join(desktop, 'b.txt') })
    await new Promise((resolve) => setTimeout(resolve, 1_500))

    expect(events<DesktopRenamed>('desktop:renamed')).toEqual([
      { id, path: join(desktop, 'b.txt') }
    ])
    expect(layout.save).toHaveBeenCalledOnce()
    expect(layoutData.paths[id]).toBe(join(desktop, 'b.txt'))
    expect(events('desktop:changed')).toHaveLength(1) // the scan's full list only
  })

  it("Explorer's rename: the watcher reports one desktop:renamed and updates paths[id] once", async () => {
    writeFileSync(join(desktop, 'a.txt'), '')
    const id = idOf(join(desktop, 'a.txt'))
    layoutData = { ...emptyLayout(), paths: { [id]: join(desktop, 'a.txt') } }
    service = create()
    await service.scan()
    await service.watch()

    renameSync(join(desktop, 'a.txt'), join(desktop, 'Renamed in Explorer.txt'))
    await waitFor(() => events('desktop:renamed').length > 0)
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    expect(events<DesktopRenamed>('desktop:renamed')).toEqual([
      { id, path: join(desktop, 'Renamed in Explorer.txt') }
    ])
    expect(layout.save).toHaveBeenCalledOnce()
    expect(layoutData.paths[id]).toBe(join(desktop, 'Renamed in Explorer.txt'))
    expect(events('desktop:changed')).toHaveLength(1)
  })

  it('a file added or deleted outside Taskyard becomes desktop:changed', async () => {
    service = create()
    await service.scan()
    await service.watch()

    writeFileSync(join(desktop, 'new.txt'), 'hello')
    await waitFor(() => events('desktop:changed').length === 2)
    const id = idOf(join(desktop, 'new.txt'))
    expect(events<DesktopChange>('desktop:changed')[1]).toEqual({
      added: [expect.objectContaining({ id, name: 'new', sizeBytes: 5 })],
      removed: [],
      changed: []
    })

    unlinkSync(join(desktop, 'new.txt'))
    await waitFor(() => events('desktop:changed').length === 3)
    expect(events<DesktopChange>('desktop:changed')[2]).toEqual({
      added: [],
      removed: [id],
      changed: []
    })
  })

  it('rescan re-emits the full list', async () => {
    writeFileSync(join(desktop, 'a.txt'), '')
    service = create()
    await service.scan()

    await service.rescan()

    const changes = events<DesktopChange>('desktop:changed')
    expect(changes).toHaveLength(2)
    expect(changes[1]).toEqual({
      added: [expect.objectContaining({ name: 'a' })],
      removed: [],
      changed: []
    })
  })

  it('stop() closes the watcher; watch() after stop() starts nothing', async () => {
    service = create()
    await service.scan()
    await service.stop()
    await service.watch()

    writeFileSync(join(desktop, 'late.txt'), '')
    await new Promise((resolve) => setTimeout(resolve, 800))

    expect(events('desktop:changed')).toHaveLength(1)
    await expect(service.stop()).resolves.toBeUndefined()
  })
})
