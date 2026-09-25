import { describe, expect, it, vi } from 'vitest'
import { emptyLayout, newDisplayLayout } from './defaults'
import {
  bringGroupToFront,
  clearPlacements,
  DEFAULT_LOOSE_CELL,
  type GroupRect,
  deleteGroup,
  ensureDisplay,
  hasDisplay,
  moveGroupToDisplay,
  moveItems,
  putGroup,
  renamePath,
  setLoosePosition,
  updateDisplay,
  updateGroup,
  updateTools
} from './layout-mutations'
import type { Group, LayoutFile } from './schema'

const PRIMARY = { x: 0, y: 0, width: 2560, height: 1440 }
const SECONDARY = { x: 2560, y: 0, width: 1920, height: 1080 }

function group(id: string, title = id): Group {
  return {
    id,
    title,
    x: 0,
    y: 0,
    w: 280,
    h: 200,
    z: 0,
    rolledUp: false,
    items: [],
    sort: 'manual',
    excludeFromQuickHide: false,
    createdAt: 0
  }
}

function layout(): LayoutFile {
  return { ...emptyLayout(), displays: [newDisplayLayout(1, PRIMARY)] }
}

describe('ensureDisplay', () => {
  it('adds a display it has not seen', () => {
    expect(ensureDisplay(emptyLayout(), { id: 2, bounds: SECONDARY }).displays).toEqual([
      newDisplayLayout(2, SECONDARY)
    ])
  })

  it('refreshes the bounds of a known display and keeps its groups', () => {
    const start = putGroup(layout(), 1, group('a'))

    const moved = ensureDisplay(start, { id: 1, bounds: SECONDARY })

    expect(moved.displays[0]).toMatchObject({ bounds: SECONDARY, groups: [group('a')] })
  })

  it('returns the same object when nothing changes', () => {
    const start = layout()

    expect(ensureDisplay(start, { id: 1, bounds: { ...PRIMARY } })).toBe(start)
  })

  it("a new display's tools widget starts from the given placement; a known one keeps its own", () => {
    const tools = { visible: false, x: 1576, y: 24 }

    const added = ensureDisplay(emptyLayout(), { id: 2, bounds: SECONDARY, tools })
    expect(added.displays[0].tools).toEqual({ ...newDisplayLayout(2, SECONDARY).tools, ...tools })

    const start = layout()
    expect(ensureDisplay(start, { id: 1, bounds: { ...PRIMARY }, tools })).toBe(start)
  })
})

describe('putGroup', () => {
  it('appends a new group, and never replaces an existing one (edits go through updateGroup)', () => {
    const added = putGroup(putGroup(layout(), 1, group('a')), 1, group('b'))

    expect(putGroup(added, 1, group('a', 'Renamed'))).toBe(added)
    expect(added.displays[0].groups).toEqual([group('a'), group('b')])
  })

  it('returns the same object for a display with no entry', () => {
    const start = layout()

    expect(putGroup(start, 99, group('a'))).toBe(start)
    expect(hasDisplay(start, 99)).toBe(false)
    expect(hasDisplay(start, 1)).toBe(true)
  })

  it('returns the same object when the group id already exists on the display', () => {
    const start = putGroup(layout(), 1, group('a'))

    expect(putGroup(start, 1, group('a'))).toBe(start)
  })

  it('does not mutate its input', () => {
    const start = layout()
    const snapshot = structuredClone(start)

    putGroup(ensureDisplay(start, { id: 2, bounds: SECONDARY }), 1, group('a'))

    expect(start).toEqual(snapshot)
  })
})

describe('updateGroup', () => {
  it('applies a field-level updater to one group', () => {
    const start = putGroup(putGroup(layout(), 1, group('a')), 1, group('b'))

    const result = updateGroup(start, 1, 'a', (g) => ({ ...g, x: 120, y: 64 }))

    expect(result.displays[0].groups).toEqual([{ ...group('a'), x: 120, y: 64 }, group('b')])
  })

  it('keeps another edit of the same group when replayed on newer data', () => {
    const start = putGroup(layout(), 1, group('a'))
    const renamed = updateGroup(start, 1, 'a', (g) => ({ ...g, title: 'Renamed' }))

    const replayedMove = updateGroup(renamed, 1, 'a', (g) => ({ ...g, x: 300 }))

    expect(replayedMove.displays[0].groups[0]).toMatchObject({ title: 'Renamed', x: 300 })
  })

  it('is a no-op for a deleted group, an unknown display or an unchanged group', () => {
    const start = putGroup(layout(), 1, group('a'))

    expect(updateGroup(start, 1, 'gone', (g) => ({ ...g, x: 5 }))).toBe(start)
    expect(updateGroup(start, 9, 'a', (g) => ({ ...g, x: 5 }))).toBe(start)
    expect(updateGroup(start, 1, 'a', (g) => g)).toBe(start)
  })
})

describe('setLoosePosition', () => {
  it('sets one item’s position and leaves the others', () => {
    const start = setLoosePosition(layout(), 1, '1:2', { x: 8, y: 8 })

    const result = setLoosePosition(start, 1, '1:3', { x: 96, y: 8 })

    expect(result.displays[0].loose).toEqual({ '1:2': { x: 8, y: 8 }, '1:3': { x: 96, y: 8 } })
  })

  it('removes the position when given null, and is a no-op when nothing changes', () => {
    const start = setLoosePosition(layout(), 1, '1:2', { x: 8, y: 8 })

    expect(setLoosePosition(start, 1, '1:2', null).displays[0].loose).toEqual({})
    expect(setLoosePosition(start, 1, '1:2', { x: 8, y: 8 })).toBe(start)
    expect(setLoosePosition(start, 9, '1:2', { x: 1, y: 1 })).toBe(start)
  })
})

describe('updateTools', () => {
  it('applies a field-level updater to the display’s tools widget', () => {
    const result = updateTools(layout(), 1, (tools) => ({ ...tools, rolledUp: true }))

    expect(result.displays[0].tools).toMatchObject({ rolledUp: true, activeTool: 'tasks' })
  })

  it('is a no-op for an unknown display or an unchanged widget', () => {
    const start = layout()

    expect(updateTools(start, 9, (tools) => ({ ...tools, x: 1 }))).toBe(start)
    expect(updateTools(start, 1, (tools) => tools)).toBe(start)
  })
})

function withGroups(...groups: Group[]): LayoutFile {
  return groups.reduce((acc, g) => putGroup(acc, 1, g), layout())
}

describe('updateDisplay', () => {
  it('applies a display-level updater, and is a no-op for an unknown display or no change', () => {
    const start = layout()

    const result = updateDisplay(start, 1, (d) => ({ ...d, bounds: SECONDARY }))

    expect(result.displays[0].bounds).toEqual(SECONDARY)
    expect(updateDisplay(start, 9, (d) => ({ ...d, bounds: SECONDARY }))).toBe(start)
    expect(updateDisplay(start, 1, (d) => d)).toBe(start)
  })
})

describe('bringGroupToFront', () => {
  it('puts the group above every other group, computed from the file it is applied to', () => {
    const start = withGroups(
      { ...group('a'), z: 3 },
      { ...group('b'), z: 7 },
      { ...group('c'), z: 1 }
    )

    const result = bringGroupToFront(start, 1, 'c')

    expect(result.displays[0].groups.find((g) => g.id === 'c')?.z).toBe(8)
  })

  it('is a no-op for the group already on top, a deleted group or an unknown display', () => {
    const start = withGroups({ ...group('a'), z: 3 }, { ...group('b'), z: 7 })

    expect(bringGroupToFront(start, 1, 'b')).toBe(start)
    expect(bringGroupToFront(start, 1, 'gone')).toBe(start)
    expect(bringGroupToFront(start, 9, 'a')).toBe(start)
  })

  it('lifts a group that shares the top z with another', () => {
    const start = withGroups({ ...group('a'), z: 7 }, { ...group('b'), z: 7 })

    expect(bringGroupToFront(start, 1, 'a').displays[0].groups[0].z).toBe(8)
  })
})

describe('moveItems', () => {
  function sample(): LayoutFile {
    const base = withGroups(
      { ...group('a'), items: ['1:1', '1:2', '1:3'] },
      { ...group('b'), items: ['1:4'] }
    )
    return setLoosePosition(base, 1, '1:9', { x: 8, y: 8 })
  }

  function items(layout: LayoutFile, groupId: string): string[] {
    return layout.displays[0].groups.find((g) => g.id === groupId)?.items ?? []
  }

  it('moves items from anywhere on the display into a group before an anchor, in the given order', () => {
    const result = moveItems(sample(), 1, ['1:9', '1:2'], { groupId: 'b', beforeId: '1:4' })

    expect(items(result, 'a')).toEqual(['1:1', '1:3'])
    expect(items(result, 'b')).toEqual(['1:9', '1:2', '1:4'])
    expect(result.displays[0].loose).toEqual({})
  })

  it('appends when the anchor is absent, null or no longer in the group', () => {
    for (const beforeId of [undefined, null, 'gone']) {
      expect(items(moveItems(sample(), 1, ['1:1'], { groupId: 'b', beforeId }), 'b')).toEqual([
        '1:4',
        '1:1'
      ])
    }
  })

  it('moves forward and backward within the same group', () => {
    expect(items(moveItems(sample(), 1, ['1:1'], { groupId: 'a', beforeId: '1:3' }), 'a')).toEqual([
      '1:2',
      '1:1',
      '1:3'
    ])
    expect(items(moveItems(sample(), 1, ['1:3'], { groupId: 'a', beforeId: '1:1' }), 'a')).toEqual([
      '1:3',
      '1:1',
      '1:2'
    ])
  })

  it('handles a multi-selection that includes items before the drop point', () => {
    const [a, b, c, d] = ['3:1', '3:2', '3:3', '3:4']
    const start = withGroups({ ...group('g'), items: [a, b, c, d] })

    // a sits before the drop point (before d): anchoring on d, not on a numeric slot, keeps it right.
    const result = moveItems(start, 1, [a, c], { groupId: 'g', beforeId: d })

    expect(items(result, 'g')).toEqual([b, a, c, d])
  })

  it('anchors on the next unmoved item when the anchor itself is being moved', () => {
    const start = withGroups({ ...group('g'), items: ['1:1', '1:2', '1:3', '1:4'] })

    const result = moveItems(start, 1, ['1:2', '1:3'], { groupId: 'g', beforeId: '1:2' })

    // Dropping a selection right before one of its own items leaves everything where it was.
    expect(result).toBe(start)
  })

  it('returns the same object when nothing changes: empty ids, a drop in place, a loose item left where it is', () => {
    const start = sample()

    expect(moveItems(start, 1, [], { groupId: 'b' })).toBe(start)
    expect(moveItems(start, 1, ['1:2'], { groupId: 'a', beforeId: '1:3' })).toBe(start)
    expect(moveItems(start, 1, ['1:3'], { groupId: 'a' })).toBe(start)
    expect(moveItems(start, 1, ['1:9'], { loose: [{ x: 8, y: 8 }] })).toBe(start)
  })

  it('moves each id once even when the selection repeats it (first occurrence wins)', () => {
    const result = moveItems(sample(), 1, ['1:1', '1:2', '1:1'], { groupId: 'b' })

    expect(items(result, 'b')).toEqual(['1:4', '1:1', '1:2'])
    const loose = moveItems(sample(), 1, ['1:1', '1:1'], {
      loose: [
        { x: 1, y: 1 },
        { x: 2, y: 2 }
      ]
    })
    expect(loose.displays[0].loose['1:1']).toEqual({ x: 1, y: 1 })
  })

  it('moves items out of groups onto the desktop at the given positions', () => {
    const result = moveItems(sample(), 1, ['1:1', '1:4'], {
      loose: [
        { x: 100, y: 10 },
        { x: 200, y: 10 }
      ]
    })

    expect(result.displays[0].groups.map((g) => g.items)).toEqual([['1:2', '1:3'], []])
    expect(result.displays[0].loose).toEqual({
      '1:9': { x: 8, y: 8 },
      '1:1': { x: 100, y: 10 },
      '1:4': { x: 200, y: 10 }
    })
  })

  it('changes nothing when the target group is gone (deleted in another window)', () => {
    const start = sample()

    expect(moveItems(start, 1, ['1:1'], { groupId: 'deleted' })).toBe(start)
    expect(moveItems(start, 9, ['1:1'], { groupId: 'a' })).toBe(start)
  })

  it('refuses loose positions that do not match the ids', () => {
    expect(() => moveItems(sample(), 1, ['1:1', '1:2'], { loose: [{ x: 0, y: 0 }] })).toThrow(
      /2 ids but 1 position/
    )
  })
})

describe('deleteGroup', () => {
  function start(): LayoutFile {
    const base = withGroups(
      { ...group('doomed'), x: 100, y: 50, w: 280, h: 200, items: ['2:1', '2:2', '2:3'] },
      { ...group('kept'), items: ['2:9'] }
    )
    return setLoosePosition(base, 1, '2:7', { x: 900, y: 900 })
  }

  it('makes the group’s current items loose, column-first from its top-left, and removes it', () => {
    const result = deleteGroup(start(), 1, 'doomed')

    expect(result.displays[0].groups.map((g) => g.id)).toEqual(['kept'])
    expect(result.displays[0].loose).toEqual({
      '2:7': { x: 900, y: 900 },
      '2:1': { x: 100, y: 50 },
      '2:2': { x: 100, y: 146 },
      '2:3': { x: 196, y: 50 }
    })
    expect(DEFAULT_LOOSE_CELL).toEqual({ width: 96, height: 96 })
  })

  it('uses the slot function it is given, fed the group as it is at apply time', () => {
    const slots = vi.fn((g: Group, count: number) =>
      Array.from({ length: count }, (_, i) => ({ x: g.x + i, y: 0 }))
    )

    const result = deleteGroup(start(), 1, 'doomed', slots)

    expect(slots).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'doomed', x: 100 }),
      3,
      expect.anything()
    )
    expect(result.displays[0].loose['2:3']).toEqual({ x: 102, y: 0 })
  })

  it('refuses a slot function that returns the wrong number of positions', () => {
    expect(() => deleteGroup(start(), 1, 'doomed', () => [])).toThrow(/3 items but 0 slots/)
  })

  it('is a no-op for a group that is already gone', () => {
    const layout = start()

    expect(deleteGroup(layout, 1, 'gone')).toBe(layout)
    expect(deleteGroup(layout, 9, 'doomed')).toBe(layout)
  })
})

describe('moveGroupToDisplay', () => {
  function twoDisplays(): LayoutFile {
    const base = ensureDisplay(
      withGroups({ ...group('g'), x: 2000, y: 1300, z: 1, title: 'Mine' }),
      { id: 2, bounds: SECONDARY }
    )
    return putGroup(base, 2, { ...group('there'), z: 6 })
  }

  it('moves the group to the other display on top, clamped there at apply time', () => {
    const clamp = vi.fn((rect: { x: number; y: number; w: number; h: number }) => ({
      ...rect,
      x: Math.min(rect.x, 1600),
      y: Math.min(rect.y, 800)
    }))

    const result = moveGroupToDisplay(twoDisplays(), 1, 'g', 2, clamp)

    expect(result.displays[0].groups).toEqual([])
    const moved = result.displays[1].groups.find((g) => g.id === 'g')
    expect(moved).toMatchObject({ title: 'Mine', x: 1600, y: 800, z: 7 })
    expect(clamp).toHaveBeenCalledWith(
      { x: 2000, y: 1300, w: 280, h: 200 },
      expect.objectContaining({ displayId: 2 })
    )
  })

  it('is a no-op for the same display, a missing group or a missing display', () => {
    const layout = twoDisplays()
    const clamp = (rect: GroupRect): GroupRect => rect

    expect(moveGroupToDisplay(layout, 1, 'g', 1, clamp)).toBe(layout)
    expect(moveGroupToDisplay(layout, 1, 'gone', 2, clamp)).toBe(layout)
    expect(moveGroupToDisplay(layout, 1, 'g', 9, clamp)).toBe(layout)
    expect(moveGroupToDisplay(layout, 9, 'g', 2, clamp)).toBe(layout)
  })
})

describe("renamePath (main applies it when a file is renamed, ours or Explorer's)", () => {
  function withPaths(): LayoutFile {
    return {
      ...emptyLayout(),
      displays: [{ ...newDisplayLayout(1, PRIMARY), loose: { '2:2': { x: 0, y: 0 } } }],
      paths: { '1:1': 'C:\\D\\a.txt' }
    }
  }

  it('updates the one path entry of a known id and nothing else', () => {
    const input = withPaths()
    const result = renamePath(input, '1:1', 'C:\\D\\b.txt')

    expect(result.paths).toEqual({ '1:1': 'C:\\D\\b.txt' })
    expect(result.displays).toBe(input.displays)
  })

  it('records the path of an id that is placed but has no path yet', () => {
    expect(renamePath(withPaths(), '2:2', 'C:\\D\\x.txt').paths).toEqual({
      '1:1': 'C:\\D\\a.txt',
      '2:2': 'C:\\D\\x.txt'
    })
  })

  it('returns the same object for the same path or an id the layout does not know', () => {
    const input = withPaths()

    expect(renamePath(input, '1:1', 'C:\\D\\a.txt')).toBe(input)
    expect(renamePath(input, '9:9', 'C:\\D\\z.txt')).toBe(input)
  })
})

describe('clearPlacements (Settings › Reset layout)', () => {
  it('removes every group and loose position on every display; widget, bounds and paths stay', () => {
    const tools = { ...newDisplayLayout(1, PRIMARY).tools, x: 900, rolledUp: true }
    const layout: LayoutFile = {
      ...emptyLayout(),
      displays: [
        {
          ...newDisplayLayout(1, PRIMARY),
          groups: [group('a')],
          loose: { '1:1': { x: 8, y: 8 } },
          tools
        },
        { ...newDisplayLayout(2, SECONDARY), groups: [group('b')] }
      ],
      paths: { '1:1': String.raw`C:\Users\me\Desktop\a.txt` },
      lastSeen: { '1:9': 5 }
    }
    const next = clearPlacements(layout)
    expect(next.displays.map((d) => [d.displayId, d.groups, d.loose])).toEqual([
      [1, [], {}],
      [2, [], {}]
    ])
    expect(next.displays[0].tools).toEqual(tools)
    expect(next.displays[1].bounds).toEqual(SECONDARY)
    expect(next.paths).toBe(layout.paths)
    expect(next.lastSeen).toBe(layout.lastSeen)
  })

  it('is the same object when there is nothing to clear', () => {
    const layout: LayoutFile = { ...emptyLayout(), displays: [newDisplayLayout(1, PRIMARY)] }
    expect(clearPlacements(layout)).toBe(layout)
  })
})
