import * as fsp from 'node:fs/promises'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DesktopIcon } from '@shared/ipc'
import type { DesktopItem } from '@shared/schema'
import { createFakeWin32Api } from '../win32/fake-api'
import { createIconService, type IconFs } from './icon-service'
import { scanDesktop } from './scanner'
import { readShortcut } from './shortcuts'
import { BENCH_COUNTS, buildBenchDesktop } from './test/fixtures'

/** Requirement: with a warm cache, all 200 fixture icons resolve from disk in ≤ 200 ms total. */
const BUDGET_MS = 200
const SCALE = [1, 1.5]

/** A ~6 KB "PNG" per icon: the real signature, then filler the size of a 96 px icon. */
const fakePng = (label: string): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(6_000, label)
  ])

const nodeFs: IconFs = {
  readFile: (path) => fsp.readFile(path),
  writeFile: (path, data) => fsp.writeFile(path, data),
  rename: (from, to) => fsp.rename(from, to),
  mkdir: (path, options) => fsp.mkdir(path, options),
  readdir: (path) => fsp.readdir(path),
  unlink: (path) => fsp.unlink(path),
  stat: (path) => fsp.stat(path)
}

describe('icon service bench (200 fixture items, warm cache)', () => {
  let desktop: string
  let cacheDir: string
  let items: DesktopItem[]

  beforeAll(async () => {
    desktop = buildBenchDesktop()
    cacheDir = mkdtempSync(join(tmpdir(), 'taskyard-bench-icons-'))
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const scanned = await scanDesktop([desktop], {
      win32: createFakeWin32Api(),
      readShortcut: (path, kind) =>
        readShortcut(path, kind, { readFile: fsp.readFile, env: {}, log }),
      log
    })
    items = scanned.items

    // Cold pass: every icon is made once (fake Electron and Win32) and written to the cache.
    const win32 = createFakeWin32Api()
    vi.spyOn(win32, 'extractIcon').mockImplementation((_file, _index, px) => ({
      width: px,
      height: px,
      bgra: Buffer.alloc(px * px * 4),
      mask: null
    }))
    const cold = createIconService({
      cacheDir,
      fs: nodeFs,
      win32,
      getFileIcon: async (path) => fakePng(path),
      encodePng: () => fakePng('extracted'),
      scaleFactors: () => SCALE,
      emit: () => {},
      log,
      systemRoot: 'C:\\Windows'
    })
    cold.update({ added: items, removed: [], changed: [] })
    await cold.idle()
    cold.stop()
    expect(log.warn).not.toHaveBeenCalled()
  })

  afterAll(() => {
    rmSync(desktop, { recursive: true, force: true })
    rmSync(cacheDir, { recursive: true, force: true })
  })

  it(`resolves all ${BENCH_COUNTS.total} icons from disk in ≤ ${BUDGET_MS} ms`, async () => {
    expect(items).toHaveLength(BENCH_COUNTS.total)
    expect(readdirSync(cacheDir).length).toBeGreaterThanOrEqual(BENCH_COUNTS.total)
    const emitted: DesktopIcon[] = []
    const getFileIcon = vi.fn(async (): Promise<Buffer> => {
      throw new Error('a warm cache must not ask Electron')
    })
    const win32 = createFakeWin32Api()
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    // A new session: empty memory cache, the files from the cold pass on disk.
    const warm = createIconService({
      cacheDir,
      fs: nodeFs,
      win32,
      getFileIcon,
      encodePng: () => {
        throw new Error('a warm cache must not encode')
      },
      scaleFactors: () => SCALE,
      emit: (_event, icon) => emitted.push(icon),
      log,
      systemRoot: 'C:\\Windows'
    })

    const started = performance.now()
    warm.update({ added: items, removed: [], changed: [] })
    await warm.idle()
    const ms = performance.now() - started
    warm.stop()

    if (process.env['TASKYARD_BENCH_VERBOSE'] === '1') {
      console.info(`icon bench: ${emitted.length} icons from disk in ${ms.toFixed(1)} ms`)
    }
    expect(new Set(emitted.map((icon) => icon.id)).size).toBe(BENCH_COUNTS.total)
    expect(emitted).toHaveLength(BENCH_COUNTS.total)
    expect(warm.stats()).toMatchObject({ cached: BENCH_COUNTS.total, shell: 0, extracted: 0 })
    expect(getFileIcon).not.toHaveBeenCalled()
    expect(win32.callsTo('extractIcon')).toEqual([])
    expect(log.warn).not.toHaveBeenCalled()
    expect(ms).toBeLessThanOrEqual(BUDGET_MS)
  })
})
