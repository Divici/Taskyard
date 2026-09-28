import { readdirSync, rmSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rectsIntersect } from '../src/shared/geometry'
import { LayoutFileSchema } from '../src/shared/schema'
import { PERF_COUNTS, PERF_GROUPS, perfLayout, writePerfDesktop } from './perf-fixture'

const DISPLAY = {
  id: 7,
  bounds: { x: 0, y: 0, width: 1707, height: 960 },
  workArea: { x: 0, y: 0, width: 1707, height: 912 }
}

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('perf fixture', () => {
  it('writes 200 desktop items, 150 of them .lnk shortcuts to real system programs', () => {
    dir = mkdtempSync(join(tmpdir(), 'taskyard-perf-fixture-test-'))
    const written = writePerfDesktop(dir)
    const names = readdirSync(dir)
    expect(names).toHaveLength(PERF_COUNTS.total)
    expect(PERF_COUNTS).toMatchObject({ total: 200, links: 150 })
    expect(names.filter((name) => extname(name) === '.lnk')).toHaveLength(150)
    expect(written).toHaveLength(200)
    expect(written.every((path) => statSync(path) !== undefined)).toBe(true)
  })

  it('lays the items out in 12 non-overlapping groups inside the work area, each item once', () => {
    const ids = Array.from({ length: PERF_COUNTS.total }, (_, i) => `1:${i + 1}`)
    const paths = Object.fromEntries(ids.map((id, i) => [id, `C:\\D\\item${i}`]))
    const layout = LayoutFileSchema.parse(perfLayout(ids, paths, DISPLAY))

    const [display] = layout.displays
    expect(display.displayId).toBe(7)
    expect(display.bounds).toEqual(DISPLAY.bounds)
    expect(display.groups).toHaveLength(PERF_GROUPS)
    expect(PERF_GROUPS).toBe(12)
    const members = display.groups.flatMap((group) => group.items)
    expect([...members].sort()).toEqual([...ids].sort())
    expect(layout.paths).toEqual(paths)

    const rects = display.groups.map((g) => ({ x: g.x, y: g.y, width: g.w, height: g.h }))
    for (const [i, rect] of rects.entries()) {
      expect(rect.x).toBeGreaterThanOrEqual(DISPLAY.workArea.x)
      expect(rect.y).toBeGreaterThanOrEqual(DISPLAY.workArea.y)
      expect(rect.x + rect.width).toBeLessThanOrEqual(DISPLAY.workArea.width)
      expect(rect.y + rect.height).toBeLessThanOrEqual(DISPLAY.workArea.height)
      for (const other of rects.slice(i + 1)) expect(rectsIntersect(rect, other)).toBe(false)
    }
    // No loose icons: every item is in a group (the drag measures many blurred groups).
    expect(display.loose).toEqual({})
  })
})
