import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { createFakeWin32Api, type FakeWin32Api } from '../../win32/fake-api'
import { DesktopModel } from '../model'
import { readDesktopItem, scanDesktop, type ScanDeps } from '../scanner'
import type { ShortcutInfo } from '../shortcuts'
import { DesktopTracker, type TrackerSink } from '../watcher'

export interface Harness {
  root: string
  /** The user Desktop (writable; the move destination). */
  desktop: string
  /** A read-only desktop folder (the Public Desktop of a standard user). */
  publicDesktop: string
  /** A folder outside the desktops, e.g. where Explorer drags come from. */
  elsewhere: string
  win32: FakeWin32Api
  model: DesktopModel
  tracker: DesktopTracker
  sink: { [K in keyof TrackerSink]: ReturnType<typeof vi.fn> }
  scanDeps: ScanDeps
  log: {
    info: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
    error: ReturnType<typeof vi.fn>
  }
  folders(): Array<{ path: string; readonly: boolean }>
  /** Scans both desktops into the model (what boot does). */
  scan(): Promise<void>
  idOf(path: string): string
  dispose(): void
}

/** Temp desktops + the real scanner, model and tracker over the fake Win32 api. */
export function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'taskyard-desktop-'))
  const desktop = join(root, 'Desktop')
  const publicDesktop = join(root, 'Public Desktop')
  const elsewhere = join(root, 'Elsewhere')
  for (const dir of [desktop, publicDesktop, elsewhere]) mkdirSync(dir)

  const win32 = createFakeWin32Api()
  win32.setFolderWritable(publicDesktop, false)
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const readShortcut = async (): Promise<ShortcutInfo> => ({})
  const scanDeps: ScanDeps = { win32, readShortcut, log }
  const folders = (): Array<{ path: string; readonly: boolean }> => [
    { path: desktop, readonly: false },
    { path: publicDesktop, readonly: true }
  ]
  const folderOf = (path: string): { path: string; readonly: boolean } =>
    folders().find((folder) => path.toUpperCase().startsWith(`${folder.path.toUpperCase()}\\`)) ??
    folders()[0]

  const model = new DesktopModel()
  const sink = { changed: vi.fn(), renamed: vi.fn(), pathsMoved: vi.fn(), replaced: vi.fn() }
  const idOf = (path: string): string => {
    const stats = statSync(path, { bigint: true })
    return `${stats.dev}:${stats.ino}`
  }
  const tracker = new DesktopTracker({
    model,
    dirs: [desktop, publicDesktop],
    readItem: (path) => readDesktopItem(path, folderOf(path), scanDeps),
    idAt: async (path) => {
      try {
        return idOf(path)
      } catch {
        return null
      }
    },
    scan: async () => (await scanDesktop([desktop, publicDesktop], scanDeps)).items,
    sink: sink as unknown as TrackerSink,
    log
  })

  return {
    root,
    desktop,
    publicDesktop,
    elsewhere,
    win32,
    model,
    tracker,
    sink,
    scanDeps,
    log,
    folders,
    async scan() {
      model.replaceAll((await scanDesktop([desktop, publicDesktop], scanDeps)).items)
    },
    idOf,
    dispose() {
      tracker.dispose()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }
}
