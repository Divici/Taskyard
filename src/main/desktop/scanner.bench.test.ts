import { rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createFakeWin32Api } from '../win32/fake-api'
import { scanDesktop } from './scanner'
import { readShortcut } from './shortcuts'
import { buildBenchDesktop, BENCH_COUNTS } from './test/fixtures'

/** Requirement: the initial scan of 200 items (150 .lnk) takes ≤ 300 ms, icons excluded. */
const BUDGET_MS = 300

describe('scanner bench (200 items, 150 .lnk)', () => {
  let dir: string

  beforeAll(() => {
    dir = buildBenchDesktop()
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it(`scans the fixture desktop in ≤ ${BUDGET_MS} ms`, async () => {
    const readShortcutLink = vi.fn(() => {
      throw new Error('the bench shortcuts all parse; the fallback must not run')
    })
    const log = { info: vi.fn(), warn: vi.fn() }
    const deps = {
      win32: createFakeWin32Api(),
      readShortcut: (path: string, kind: 'link' | 'url') =>
        readShortcut(path, kind, { readFile, readShortcutLink, env: process.env, log }),
      log
    }

    const report = await scanDesktop([dir], deps)

    if (process.env['TASKYARD_BENCH_VERBOSE'] === '1') {
      console.info(`scanner bench: ${report.items.length} items in ${report.ms.toFixed(1)} ms`)
    }
    expect(report.items).toHaveLength(BENCH_COUNTS.total)
    expect(report.items.filter((item) => item.kind === 'link')).toHaveLength(BENCH_COUNTS.links)
    expect(report.items.filter((item) => item.targetPath !== undefined)).toHaveLength(
      BENCH_COUNTS.links
    )
    expect(readShortcutLink).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
    expect(report.ms).toBeLessThanOrEqual(BUDGET_MS)
  })
})
