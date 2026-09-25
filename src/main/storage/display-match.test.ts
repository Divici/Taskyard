import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyLayout, newDisplayLayout } from '@shared/defaults'
import { rectsIntersect } from '@shared/geometry'
import type { DisplayLayout, Group, LayoutFile, Rect } from '@shared/schema'
import {
  DEOVERLAP_STEP,
  DISPLAY_SETTLE_MS,
  deOverlap,
  matchDisplays,
  rematchLayout,
  startDisplayMatching,
  type DisplayMatchingDeps,
  type ScreenDisplay
} from './display-match'

const CELL = { width: 96, height: 96 }

/** A display with a 48 px taskbar at the bottom. */
function screenDisplay(
  id: number,
  x: number,
  y: number,
  width: number,
  height: number
): ScreenDisplay {
  return {
    id,
    bounds: { x, y, width, height },
    workArea: { x, y, width, height: height - 48 }
  }
}

function group(
  id: string,
  x: number,
  y: number,
  w = 300,
  h = 200,
  z = 1,
  items: string[] = []
): Group {
  return {
    id,
    title: id,
    x,
    y,
    w,
    h,
    z,
    rolledUp: false,
    items,
    sort: 'manual',
    excludeFromQuickHide: false,
    createdAt: 1
  }
}

function entry(
  displayId: number,
  bounds: Rect,
  groups: Group[] = [],
  loose: DisplayLayout['loose'] = {}
): DisplayLayout {
  return { ...newDisplayLayout(displayId, bounds), groups, loose }
}

function layoutOf(...displays: DisplayLayout[]): LayoutFile {
  return { ...emptyLayout(), displays }
}

const PRIMARY = screenDisplay(10, 0, 0, 2560, 1440)
const RIGHT = screenDisplay(20, 2560, 0, 1920, 1080)

describe('matchDisplays: which current display each saved entry belongs to', () => {
  it('matches the same display id first', () => {
    const saved = [
      entry(20, RIGHT.bounds, [group('g', 0, 0)]),
      entry(10, PRIMARY.bounds, [group('h', 0, 0)])
    ]
    expect(matchDisplays(saved, [PRIMARY, RIGHT], PRIMARY.id)).toEqual([
      { displayId: 20, by: 'id' },
      { displayId: 10, by: 'id' }
    ])
  })

  it('two identical monitors whose ids changed: matched by size and position, never swapped', () => {
    const left = screenDisplay(3, 0, 0, 1920, 1080)
    const right = screenDisplay(4, 1920, 0, 1920, 1080)
    const saved = [
      entry(2, { x: 1920, y: 0, width: 1920, height: 1080 }, [group('right', 0, 0)]),
      entry(1, { x: 0, y: 0, width: 1920, height: 1080 }, [group('left', 0, 0)])
    ]
    expect(matchDisplays(saved, [left, right], left.id)).toEqual([
      { displayId: 4, by: 'position' },
      { displayId: 3, by: 'position' }
    ])
  })

  it('then the same size (the monitor moved to another port or place)', () => {
    const moved = screenDisplay(30, -1920, 0, 1920, 1080)
    const saved = [entry(20, RIGHT.bounds, [group('g', 0, 0)])]
    expect(matchDisplays(saved, [PRIMARY, moved], PRIMARY.id)).toEqual([
      { displayId: 30, by: 'size' }
    ])
  })

  it('a display another entry already claimed is not matched again by size', () => {
    const only = screenDisplay(5, 0, 0, 1920, 1080)
    const saved = [
      entry(5, only.bounds, [group('a', 0, 0)]),
      entry(6, { x: 1920, y: 0, width: 1920, height: 1080 }, [group('b', 0, 0)])
    ]
    expect(matchDisplays(saved, [only], only.id)).toEqual([
      { displayId: 5, by: 'id' },
      { displayId: 5, by: 'primary' }
    ])
  })

  it('an entry with no match goes to the primary display', () => {
    const saved = [entry(99, { x: 5000, y: 0, width: 3840, height: 2160 }, [group('g', 0, 0)])]
    expect(matchDisplays(saved, [PRIMARY, RIGHT], PRIMARY.id)).toEqual([
      { displayId: 10, by: 'primary' }
    ])
  })

  it('an empty entry (a window registered it before main re-matched) does not claim its display', () => {
    const replugged = screenDisplay(21, 2560, 0, 1920, 1080)
    const saved = [entry(20, RIGHT.bounds, [group('g', 0, 0)]), entry(21, replugged.bounds)]
    expect(matchDisplays(saved, [PRIMARY, replugged], PRIMARY.id)).toEqual([
      { displayId: 21, by: 'position' },
      { displayId: 21, by: 'id' }
    ])
  })
})

describe('deOverlap', () => {
  const area = { x: 0, y: 0, width: 1000, height: 800 }

  it('keeps a rect that overlaps nothing (clamped into the area)', () => {
    expect(deOverlap({ x: 900, y: 100, width: 300, height: 200 }, [], area)).toEqual({
      x: 700,
      y: 100,
      width: 300,
      height: 200
    })
  })

  it('steps down and right by 24 px until it is clear', () => {
    const taken = [{ x: 0, y: 0, width: 300, height: 200 }]
    const placed = deOverlap({ x: 0, y: 0, width: 300, height: 200 }, taken, area)
    expect(placed.x % DEOVERLAP_STEP).toBe(0)
    expect(placed.x).toBe(placed.y)
    expect(taken.some((rect) => rectsIntersect(rect, placed))).toBe(false)
    expect(placed).toEqual({ x: 216, y: 216, width: 300, height: 200 })
  })

  it('finds a free spot elsewhere when the diagonal runs into the corner', () => {
    const taken = [{ x: 600, y: 500, width: 400, height: 300 }]
    const placed = deOverlap({ x: 700, y: 600, width: 300, height: 200 }, taken, area)
    expect(taken.some((rect) => rectsIntersect(rect, placed))).toBe(false)
    expect(placed.x).toBeGreaterThanOrEqual(0)
    expect(placed.y + placed.height).toBeLessThanOrEqual(800)
  })

  it('gives up gracefully (clamped, overlapping) when the area is full', () => {
    const taken = [area]
    expect(deOverlap({ x: 10, y: 10, width: 300, height: 200 }, taken, area)).toEqual({
      x: 10,
      y: 10,
      width: 300,
      height: 200
    })
  })
})

describe('rematchLayout', () => {
  it('returns the same layout when every entry is its display, where it was', () => {
    const layout = layoutOf(entry(10, PRIMARY.bounds, [group('g', 0, 0)]), entry(20, RIGHT.bounds))
    expect(rematchLayout(layout, [PRIMARY, RIGHT], PRIMARY.id, { cell: CELL })).toBe(layout)
  })

  it('a display whose id changed keeps its groups, loose icons and widget under the new id', () => {
    const tools = {
      x: 1500,
      y: 24,
      w: 320,
      h: 400,
      rolledUp: true,
      visible: true,
      activeTool: 'timer' as const
    }
    const old: DisplayLayout = {
      ...entry(20, RIGHT.bounds, [group('g', 40, 40)], { '1:1': { x: 8, y: 8 } }),
      tools
    }
    const replugged = screenDisplay(21, 2560, 0, 1920, 1080)
    const next = rematchLayout(
      layoutOf(entry(10, PRIMARY.bounds), old),
      [PRIMARY, replugged],
      PRIMARY.id,
      {
        cell: CELL
      }
    )
    expect(next.displays.map((d) => d.displayId)).toEqual([10, 21])
    expect(next.displays[1]).toEqual({ ...old, displayId: 21 })
  })

  it('an entry matched by size takes the display’s new bounds', () => {
    const moved = screenDisplay(30, -1920, 0, 1920, 1080)
    const next = rematchLayout(
      layoutOf(entry(10, PRIMARY.bounds), entry(20, RIGHT.bounds, [group('g', 40, 40)])),
      [PRIMARY, moved],
      PRIMARY.id,
      { cell: CELL }
    )
    expect(next.displays[1].displayId).toBe(30)
    expect(next.displays[1].bounds).toEqual(moved.bounds)
    expect(next.displays[1].groups).toEqual([group('g', 40, 40)])
  })

  it('replaces an empty entry a window registered for the re-plugged display', () => {
    const replugged = screenDisplay(21, 2560, 0, 1920, 1080)
    const next = rematchLayout(
      layoutOf(
        entry(10, PRIMARY.bounds),
        entry(20, RIGHT.bounds, [group('g', 40, 40)]),
        entry(21, replugged.bounds)
      ),
      [PRIMARY, replugged],
      PRIMARY.id,
      { cell: CELL }
    )
    expect(next.displays.map((d) => d.displayId)).toEqual([10, 21])
    expect(next.displays[1].groups.map((g) => g.id)).toEqual(['g'])
  })

  describe('a removed monitor', () => {
    const removed = entry(
      20,
      RIGHT.bounds,
      [group('far', 1700, 900, 300, 200, 1, ['1:5']), group('twin', 24, 24, 300, 200, 2)],
      { '1:7': { x: 8, y: 8 }, '1:8': { x: 8, y: 104 } }
    )
    const primary = entry(10, PRIMARY.bounds, [group('home', 24, 24, 300, 200, 4)], {
      '1:1': { x: 2400, y: 8 }
    })
    const layout: LayoutFile = {
      ...layoutOf(primary, removed),
      paths: { '1:7': 'C:\\Users\\me\\Desktop\\b.txt', '1:8': 'C:\\Users\\me\\Desktop\\a.txt' }
    }
    const area = { x: 0, y: 0, width: 2560, height: 1392 }

    it('moves its groups to the primary display, clamped, de-overlapped and on top', () => {
      const next = rematchLayout(layout, [PRIMARY], PRIMARY.id, { cell: CELL })
      expect(next.displays.map((d) => d.displayId)).toEqual([10])
      const groups = next.displays[0].groups
      expect(groups.map((g) => g.id)).toEqual(['home', 'far', 'twin'])
      for (const g of groups) {
        expect(g.x).toBeGreaterThanOrEqual(area.x)
        expect(g.y).toBeGreaterThanOrEqual(area.y)
        expect(g.x + g.w).toBeLessThanOrEqual(area.x + area.width)
        expect(g.y + g.h).toBeLessThanOrEqual(area.y + area.height)
      }
      const rects = groups.map((g) => ({ x: g.x, y: g.y, width: g.w, height: g.h }))
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(rectsIntersect(rects[i], rects[j])).toBe(false)
        }
      }
      // "twin" sat exactly on "home": it steps 24 px at a time until it is clear.
      expect(groups[2]).toMatchObject({ x: 24 + 9 * DEOVERLAP_STEP, y: 24 + 9 * DEOVERLAP_STEP })
      // Stacked above the primary's own groups, in their old order; members kept.
      expect(groups[1]).toMatchObject({ z: 5, items: ['1:5'] })
      expect(groups[2].z).toBe(6)
    })

    it('its loose icons land in free cells on the primary display', () => {
      const next = rematchLayout(layout, [PRIMARY], PRIMARY.id, { cell: CELL })
      const loose = next.displays[0].loose
      expect(Object.keys(loose).sort()).toEqual(['1:1', '1:7', '1:8'])
      expect(loose['1:1']).toEqual({ x: 2400, y: 8 })
      for (const id of ['1:7', '1:8']) {
        expect(loose[id].x).toBeGreaterThanOrEqual(0)
        expect(loose[id].y + CELL.height).toBeLessThanOrEqual(area.height)
      }
      // Sorted by name, like any new icon: a.txt (1:8) before b.txt (1:7).
      expect(loose['1:8'].y).toBeLessThan(loose['1:7'].y)
    })

    it('is stable: matching again changes nothing', () => {
      const once = rematchLayout(layout, [PRIMARY], PRIMARY.id, { cell: CELL })
      expect(rematchLayout(once, [PRIMARY], PRIMARY.id, { cell: CELL })).toBe(once)
    })

    it('parks the monitor’s original entry (groups, loose icons, widget) in the file', () => {
      const next = rematchLayout(layout, [PRIMARY], PRIMARY.id, { cell: CELL })
      expect(next.parked).toEqual([
        {
          entry: removed,
          hostDisplayId: 10,
          groupIds: ['far', 'twin'],
          looseIds: ['1:7', '1:8']
        }
      ])
    })

    it('without park (start-up, before displays settle) leaves the entry untouched', () => {
      expect(rematchLayout(layout, [PRIMARY], PRIMARY.id, { cell: CELL, park: false })).toBe(layout)
    })

    describe('when the monitor comes back', () => {
      const away = rematchLayout(layout, [PRIMARY], PRIMARY.id, { cell: CELL })

      it('by the same id: everything goes back where it was, the copies leave the primary', () => {
        const back = rematchLayout(away, [PRIMARY, RIGHT], PRIMARY.id, { cell: CELL })
        expect(back.parked ?? []).toEqual([])
        expect(back.displays.map((d) => d.displayId)).toEqual([10, 20])
        expect(back.displays[0]).toEqual(primary)
        expect(back.displays[1]).toEqual(removed)
        expect(back.paths).toEqual(layout.paths)
      })

      it('with a new id (a window already registered an empty entry): matched by position', () => {
        const replugged = screenDisplay(21, 2560, 0, 1920, 1080)
        const withBlank = { ...away, displays: [...away.displays, entry(21, replugged.bounds)] }
        const back = rematchLayout(withBlank, [PRIMARY, replugged], PRIMARY.id, { cell: CELL })
        expect(back.parked ?? []).toEqual([])
        expect(back.displays.map((d) => d.displayId)).toEqual([10, 21])
        expect(back.displays[0]).toEqual(primary)
        expect(back.displays[1]).toEqual({ ...removed, displayId: 21 })
      })

      it('keeps what the user changed on the copies, but not where they were moved', () => {
        const edited: LayoutFile = {
          ...away,
          displays: away.displays.map((d) => ({
            ...d,
            groups: d.groups
              .filter((g) => g.id !== 'twin')
              .map((g) => (g.id === 'far' ? { ...g, title: 'Renamed', x: 5, y: 5 } : g))
          }))
        }
        const back = rematchLayout(edited, [PRIMARY, RIGHT], PRIMARY.id, { cell: CELL })
        // "twin" was deleted meanwhile: it stays deleted.
        expect(back.displays[1].groups).toEqual([{ ...removed.groups[0], title: 'Renamed' }])
        expect(back.displays[0].groups.map((g) => g.id)).toEqual(['home'])
      })

      it('an icon the user grouped on the primary meanwhile stays in its group', () => {
        const regrouped: LayoutFile = {
          ...away,
          displays: away.displays.map((d) => {
            const loose = { ...d.loose }
            delete loose['1:7']
            return {
              ...d,
              loose,
              groups: d.groups.map((g) => (g.id === 'home' ? { ...g, items: ['1:7'] } : g))
            }
          })
        }
        const back = rematchLayout(regrouped, [PRIMARY, RIGHT], PRIMARY.id, { cell: CELL })
        expect(back.displays[1].loose).toEqual({ '1:8': { x: 8, y: 104 } })
        expect(back.displays[0].groups.find((g) => g.id === 'home')!.items).toEqual(['1:7'])
      })
    })
  })
})

describe('cascading disconnects (a host that goes away while it holds copies)', () => {
  // Three monitors of different sizes. Groups of a missing monitor go to the *primary*, so the
  // cascade needs the primary to change: A goes while H is primary (A's copies land on H), then
  // H goes and P is primary (H is parked while it holds A's copies).
  const P = screenDisplay(10, 0, 0, 2560, 1440)
  const H = screenDisplay(20, 2560, 0, 1920, 1080)
  const A = screenDisplay(30, 4480, 0, 1680, 1050)
  const opts = { cell: CELL }

  function start(): LayoutFile {
    return {
      ...layoutOf(
        entry(10, P.bounds, [group('p1', 24, 24, 300, 200, 1, ['1:1'])]),
        entry(20, H.bounds, [group('h1', 24, 24, 300, 200, 1, ['1:2'])], { '1:3': { x: 8, y: 8 } }),
        entry(30, A.bounds, [group('a1', 24, 24, 300, 200, 1, ['1:4'])], { '1:5': { x: 8, y: 8 } })
      ),
      paths: { '1:3': 'C:\\D\\c.txt', '1:5': 'C:\\D\\e.txt' }
    }
  }

  /** A window registers an empty entry for a connected display that has none (ensureDisplay). */
  function register(layout: LayoutFile, displays: readonly ScreenDisplay[]): LayoutFile {
    const missing = displays.filter((d) => !layout.displays.some((e) => e.displayId === d.id))
    return missing.length === 0
      ? layout
      : { ...layout, displays: [...layout.displays, ...missing.map((d) => entry(d.id, d.bounds))] }
  }

  /** The first connected display is the primary. */
  function step(layout: LayoutFile, displays: readonly ScreenDisplay[]): LayoutFile {
    return register(rematchLayout(layout, displays, displays[0].id, opts), displays)
  }

  /** Group ids per display, in order (`id@display`). */
  const where = (layout: LayoutFile): string[] =>
    layout.displays.flatMap((d) => d.groups.map((g) => `${g.id}@${d.displayId}`)).sort()

  function assertNoDuplicates(layout: LayoutFile): void {
    const groupIds = layout.displays.flatMap((d) => d.groups.map((g) => g.id))
    expect(new Set(groupIds).size).toBe(groupIds.length)
    const itemIds = layout.displays.flatMap((d) => [
      ...Object.keys(d.loose),
      ...d.groups.flatMap((g) => g.items)
    ])
    expect(new Set(itemIds).size).toBe(itemIds.length)
    const parkedIds = (layout.parked ?? []).flatMap((p) => p.entry.groups.map((g) => g.id))
    expect(new Set(parkedIds).size).toBe(parkedIds.length)
    const parkedItems = (layout.parked ?? []).flatMap((p) => [
      ...Object.keys(p.entry.loose),
      ...p.entry.groups.flatMap((g) => g.items)
    ])
    expect(new Set(parkedItems).size).toBe(parkedItems.length)
    // A parked group's copy is shown on its host only.
    for (const parked of layout.parked ?? []) {
      for (const id of parked.groupIds) {
        const on = layout.displays.filter((d) => d.groups.some((g) => g.id === id))
        expect(on.map((d) => d.displayId).every((d) => d === parked.hostDisplayId)).toBe(true)
      }
    }
  }

  const all = [P, H, A]
  let layout = start()
  // 1) A goes: its copies land on H. 2) H goes too: H's and A's groups land on P.
  const aGone = step(layout, [H, P])
  const bothGone = step(aGone, [P])

  it('a host that goes away takes only its own groups into its parked entry; guests are re-homed', () => {
    expect(where(aGone)).toEqual(['a1@20', 'h1@20', 'p1@10'])
    expect(where(bothGone)).toEqual(['a1@10', 'h1@10', 'p1@10'])
    const parkedH = bothGone.parked!.find((p) => p.entry.displayId === 20)!
    expect(parkedH.entry.groups.map((g) => g.id)).toEqual(['h1'])
    expect(Object.keys(parkedH.entry.loose)).toEqual(['1:3'])
    expect(parkedH.groupIds).toEqual(['h1'])
    const parkedA = bothGone.parked!.find((p) => p.entry.displayId === 30)!
    expect(parkedA.hostDisplayId).toBe(10)
    assertNoDuplicates(aGone)
    assertNoDuplicates(bothGone)
  })

  it('A returns first, then H: every group back on its own monitor, once', () => {
    const aBack = step(bothGone, [P, A])
    expect(where(aBack)).toEqual(['a1@30', 'h1@10', 'p1@10'])
    assertNoDuplicates(aBack)
    const allBack = step(aBack, all)
    expect(where(allBack)).toEqual(['a1@30', 'h1@20', 'p1@10'])
    expect(allBack.parked ?? []).toEqual([])
    assertNoDuplicates(allBack)
    expect(allBack.displays.find((d) => d.displayId === 20)!.loose).toEqual({
      '1:3': { x: 8, y: 8 }
    })
    expect(allBack.displays.find((d) => d.displayId === 30)!.loose).toEqual({
      '1:5': { x: 8, y: 8 }
    })
  })

  it('H returns first, then A: every group back on its own monitor, once', () => {
    const hBack = step(bothGone, [P, H])
    expect(where(hBack)).toEqual(['a1@10', 'h1@20', 'p1@10'])
    assertNoDuplicates(hBack)
    const allBack = step(hBack, all)
    expect(where(allBack)).toEqual(['a1@30', 'h1@20', 'p1@10'])
    expect(allBack.parked ?? []).toEqual([])
    assertNoDuplicates(allBack)
  })

  it('invariant over random connect/disconnect sequences: no id twice, nothing lost', () => {
    // Deterministic PRNG (mulberry32), so a failure is reproducible.
    let seed = 0x5eed
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const originalGroups = where(start())
      .map((g) => g.split('@')[0])
      .sort()
    for (let run = 0; run < 200; run++) {
      layout = start()
      for (let i = 0; i < 12; i++) {
        // Any non-empty set of monitors, in a random order (the first one is the primary).
        const connected = all.filter(() => random() < 0.6).sort(() => random() - 0.5)
        if (connected.length === 0) connected.push(all[Math.floor(random() * 3)])
        layout = step(layout, connected)
        assertNoDuplicates(layout)
        const shown = where(layout)
          .map((g) => g.split('@')[0])
          .sort()
        expect(shown).toEqual(originalGroups)
      }
      layout = step(layout, all)
      assertNoDuplicates(layout)
      expect(where(layout)).toEqual(['a1@30', 'h1@20', 'p1@10'])
      expect(layout.parked ?? []).toEqual([])
    }
  })
})

describe('startDisplayMatching (main is the single writer)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  interface Harness extends DisplayMatchingDeps {
    listeners: Map<string, () => void>
    current(): LayoutFile
    storage: DisplayMatchingDeps['storage'] & {
      layout: { save: ReturnType<typeof vi.fn> }
    }
    log: DisplayMatchingDeps['log'] & {
      info: ReturnType<typeof vi.fn>
      error: ReturnType<typeof vi.fn>
    }
  }

  function harness(displays: ScreenDisplay[], layout: LayoutFile): Harness {
    const listeners = new Map<string, () => void>()
    const screen = {
      getAllDisplays: vi.fn(() => displays),
      getPrimaryDisplay: vi.fn(() => displays[0]),
      on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      removeListener: vi.fn((event: string) => listeners.delete(event))
    }
    let current = layout
    const storage = {
      layout: {
        get: vi.fn(() => current),
        save: vi.fn((data: LayoutFile) => {
          current = data
          return { ok: true as const, revision: 2 }
        })
      },
      settings: { get: () => ({ iconSize: 'medium' as const }) }
    }
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    return { screen, storage, log, listeners, current: () => current }
  }

  it('at start-up only re-ids; a missing monitor is parked only once displays have settled', () => {
    vi.useFakeTimers()
    const replugged = screenDisplay(21, 2560, 0, 1920, 1080)
    const h = harness(
      [PRIMARY, replugged],
      layoutOf(entry(10, PRIMARY.bounds), entry(20, RIGHT.bounds, [group('g', 40, 40)]))
    )
    const stop = startDisplayMatching(h)
    // Re-id at once (before the windows register theirs): 20 → 21 by position.
    expect(h.storage.layout.save).toHaveBeenCalledOnce()
    expect(h.current().displays.map((d) => d.displayId)).toEqual([10, 21])
    expect(h.log.info).toHaveBeenCalledWith(expect.stringContaining('display 20 → 21 (position)'))
    stop()
  })

  it('a monitor that appears after start-up (late enumeration) never has its groups merged', () => {
    vi.useFakeTimers()
    const displays = [PRIMARY]
    const start = layoutOf(entry(10, PRIMARY.bounds), entry(20, RIGHT.bounds, [group('g', 40, 40)]))
    const h = harness(displays, start)
    startDisplayMatching(h)
    expect(h.storage.layout.save).not.toHaveBeenCalled()

    vi.advanceTimersByTime(DISPLAY_SETTLE_MS - 500)
    displays.push(RIGHT)
    h.listeners.get('display-added')!()
    vi.advanceTimersByTime(DISPLAY_SETTLE_MS)
    expect(h.storage.layout.save).not.toHaveBeenCalled()
    expect(h.current()).toBe(start)
  })

  it('a monitor gone for good: after the settle delay its groups stay on the primary, parked entry saved', () => {
    vi.useFakeTimers()
    const h = harness(
      [PRIMARY],
      layoutOf(entry(10, PRIMARY.bounds), entry(20, RIGHT.bounds, [group('g', 40, 40)]))
    )
    startDisplayMatching(h)
    vi.advanceTimersByTime(DISPLAY_SETTLE_MS)
    expect(h.storage.layout.save).toHaveBeenCalledOnce()
    const saved = h.current()
    expect(saved.displays.map((d) => d.displayId)).toEqual([10])
    expect(saved.displays[0].groups.map((g) => g.id)).toEqual(['g'])
    expect(saved.parked?.map((p) => p.entry.displayId)).toEqual([20])
    expect(h.log.info).toHaveBeenCalledWith(expect.stringContaining('display 20 → 10 (primary)'))
  })

  it('a monitor that returns after the settle delay gets its layout back', () => {
    vi.useFakeTimers()
    const displays = [PRIMARY]
    const original = entry(20, RIGHT.bounds, [group('g', 40, 40)], { '1:1': { x: 8, y: 8 } })
    const h = harness(displays, {
      ...layoutOf(entry(10, PRIMARY.bounds), original),
      paths: { '1:1': 'C:\\D\\a.txt' }
    })
    startDisplayMatching(h)
    vi.advanceTimersByTime(DISPLAY_SETTLE_MS)
    expect(h.current().displays.map((d) => d.displayId)).toEqual([10])

    displays.push(RIGHT)
    h.listeners.get('display-added')!()
    vi.advanceTimersByTime(DISPLAY_SETTLE_MS)
    expect(h.current().displays).toEqual([entry(10, PRIMARY.bounds), original])
    expect(h.current().parked ?? []).toEqual([])
  })

  it('a failing match is logged; it never throws out of start-up or a display event', () => {
    vi.useFakeTimers()
    const h = harness([PRIMARY], layoutOf(entry(10, PRIMARY.bounds)))
    h.storage.layout.get = vi.fn(() => {
      throw new Error('layout not loaded')
    })
    expect(() => startDisplayMatching(h)).not.toThrow()
    expect(h.log.error).toHaveBeenCalledWith('displays: re-matching failed', expect.any(Error))
    expect(() => vi.advanceTimersByTime(DISPLAY_SETTLE_MS)).not.toThrow()
    h.listeners.get('display-added')!()
    expect(() => vi.advanceTimersByTime(DISPLAY_SETTLE_MS)).not.toThrow()
  })

  it('re-matches after displays settle (added or removed), and stops listening when stopped', () => {
    vi.useFakeTimers()
    const displays = [PRIMARY, RIGHT]
    const h = harness(
      displays,
      layoutOf(entry(10, PRIMARY.bounds), entry(20, RIGHT.bounds, [group('g', 40, 40)]))
    )
    const stop = startDisplayMatching(h)
    expect(h.storage.layout.save).not.toHaveBeenCalled()

    displays.pop()
    h.listeners.get('display-removed')!()
    vi.advanceTimersByTime(DISPLAY_SETTLE_MS - 1)
    expect(h.storage.layout.save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(h.storage.layout.save).toHaveBeenCalledOnce()
    expect(h.current().displays[0].groups.map((g) => g.id)).toEqual(['g'])

    stop()
    expect(h.listeners.size).toBe(0)
  })

  it('a monitor that comes back before the settle delay moves nothing', () => {
    vi.useFakeTimers()
    const displays = [PRIMARY, RIGHT]
    const h = harness(
      displays,
      layoutOf(entry(10, PRIMARY.bounds), entry(20, RIGHT.bounds, [group('g', 40, 40)]))
    )
    startDisplayMatching(h)
    displays.pop()
    h.listeners.get('display-removed')!()
    displays.push(RIGHT)
    h.listeners.get('display-added')!()
    vi.advanceTimersByTime(DISPLAY_SETTLE_MS)
    expect(h.storage.layout.save).not.toHaveBeenCalled()
  })
})
