import { describe, expect, it } from 'vitest'
import { emptyLayout, newDisplayLayout } from './defaults'
import {
  cellAt,
  looseDropPositions,
  placeItems,
  placementsOf,
  restorePlacements
} from './drop-placement'
import type { Group, LayoutFile } from './schema'

const PRIMARY = { x: 0, y: 0, width: 2560, height: 1440 }
const SECONDARY = { x: 2560, y: 0, width: 1920, height: 1080 }
const AREA = { x: 0, y: 0, width: 400, height: 300 }
const CELL = { width: 100, height: 100 }

function group(id: string, items: string[], patch: Partial<Group> = {}): Group {
  return {
    id,
    title: id,
    x: 0,
    y: 0,
    w: 280,
    h: 200,
    z: 1,
    rolledUp: false,
    items,
    sort: 'manual',
    excludeFromQuickHide: false,
    createdAt: 1,
    ...patch
  }
}

function twoDisplays(): LayoutFile {
  return {
    ...emptyLayout(),
    displays: [
      {
        ...newDisplayLayout(1, PRIMARY),
        groups: [group('a', ['1:1', '1:2', '1:3']), group('b', ['1:4'])],
        loose: { '1:5': { x: 0, y: 0 } }
      },
      { ...newDisplayLayout(2, SECONDARY), loose: { '1:6': { x: 100, y: 100 } } }
    ],
    paths: { '1:6': 'C:\\D\\six.txt' }
  }
}

describe('placeItems', () => {
  it('places ids on one display and removes them from every other display', () => {
    const next = placeItems(twoDisplays(), 1, ['1:6', '1:9'], { groupId: 'b', beforeId: '1:4' })

    expect(next.displays[0].groups[1].items).toEqual(['1:6', '1:9', '1:4'])
    expect(next.displays[1].loose).toEqual({})
    // Paths and stamps are left to reconcile.
    expect(next.paths).toEqual({ '1:6': 'C:\\D\\six.txt' })
  })

  it('places loose at the given positions', () => {
    const next = placeItems(twoDisplays(), 1, ['1:1'], { loose: [{ x: 200, y: 100 }] })

    expect(next.displays[0].loose).toEqual({ '1:5': { x: 0, y: 0 }, '1:1': { x: 200, y: 100 } })
    expect(next.displays[0].groups[0].items).toEqual(['1:2', '1:3'])
  })

  it('returns the same object when nothing changes', () => {
    const start = twoDisplays()
    expect(placeItems(start, 1, ['1:5'], { loose: [{ x: 0, y: 0 }] })).toBe(start)
    expect(placeItems(start, 1, [], { groupId: 'a' })).toBe(start)
  })
})

describe('placementsOf / restorePlacements', () => {
  it('records where each id is (group + the next item that stays, loose point, or nowhere)', () => {
    const snapshot = placementsOf(twoDisplays(), ['1:2', '1:1', '1:5', '1:7'])

    expect(snapshot).toEqual([
      { id: '1:2', displayId: 1, at: { groupId: 'a', beforeId: '1:3' } },
      { id: '1:1', displayId: 1, at: { groupId: 'a', beforeId: '1:3' } },
      { id: '1:5', displayId: 1, at: { loose: { x: 0, y: 0 } } },
      { id: '1:7', displayId: null, at: null }
    ])
  })

  it('puts every id back where it was, in its old order, and forgets the ids that had no place', () => {
    const start = twoDisplays()
    const ids = ['1:1', '1:2', '1:5', '1:7']
    const snapshot = placementsOf(start, ids)
    const dropped = placeItems(start, 1, ids, { groupId: 'b' })
    expect(dropped.displays[0].groups[1].items).toEqual(['1:4', '1:1', '1:2', '1:5', '1:7'])

    const restored = restorePlacements(dropped, snapshot)

    expect(restored.displays[0].groups[0].items).toEqual(['1:1', '1:2', '1:3'])
    expect(restored.displays[0].groups[1].items).toEqual(['1:4'])
    expect(restored.displays[0].loose).toEqual({ '1:5': { x: 0, y: 0 } })
  })

  it('restores the last item of a group at its end', () => {
    const start = twoDisplays()
    const snapshot = placementsOf(start, ['1:3'])
    expect(snapshot[0].at).toEqual({ groupId: 'a', beforeId: null })

    const restored = restorePlacements(placeItems(start, 1, ['1:3'], { groupId: 'b' }), snapshot)

    expect(restored.displays[0].groups[0].items).toEqual(['1:1', '1:2', '1:3'])
  })
})

describe('cellAt', () => {
  it('is the grid cell whose centre is nearest the point, kept inside the area', () => {
    expect(cellAt({ x: 149, y: 40 }, CELL, AREA)).toEqual({ x: 100, y: 0 })
    expect(cellAt({ x: 151, y: 160 }, CELL, AREA)).toEqual({ x: 100, y: 100 })
    expect(cellAt({ x: 5000, y: 5000 }, CELL, AREA)).toEqual({ x: 300, y: 200 })
    expect(cellAt({ x: -40, y: -40 }, CELL, AREA)).toEqual({ x: 0, y: 0 })
    // The grid starts at the work area's corner (a taskbar on the left or top).
    expect(cellAt({ x: 70, y: 70 }, CELL, { x: 48, y: 0, width: 400, height: 300 })).toEqual({
      x: 48,
      y: 0
    })
  })
})

describe('looseDropPositions', () => {
  const display = {
    groups: [group('g', [], { x: 200, y: 0, w: 200, h: 100 })],
    loose: { '1:1': { x: 0, y: 0 }, '1:2': { x: 0, y: 100 }, '1:9': { x: 100, y: 0 } }
  }

  it('puts one item in the cell under the drop point when it is free', () => {
    expect(
      looseDropPositions({
        ids: ['1:5'],
        activeId: '1:5',
        anchor: { x: 100, y: 200 },
        display,
        cell: CELL,
        area: AREA
      })
    ).toEqual([{ x: 100, y: 200 }])
  })

  it('moves to the next free cell (column-first) when the cell is taken', () => {
    expect(
      looseDropPositions({
        ids: ['1:5'],
        activeId: '1:5',
        anchor: { x: 0, y: 0 },
        display,
        cell: CELL,
        area: AREA
      })
    ).toEqual([{ x: 0, y: 200 }])
  })

  it('fills cells column-first from the drop cell, in the order given, skipping taken ones', () => {
    expect(
      looseDropPositions({
        ids: ['1:5', '1:6', '1:7'],
        activeId: '1:6',
        anchor: { x: 100, y: 100 },
        display,
        cell: CELL,
        area: AREA
      })
    ).toEqual([
      { x: 100, y: 100 },
      { x: 100, y: 200 },
      // Column 2 row 0 is under the group: skipped.
      { x: 200, y: 100 }
    ])
  })

  it('keeps the arrangement of loose icons moved together, the grabbed one landing on the anchor', () => {
    expect(
      looseDropPositions({
        ids: ['1:1', '1:2'],
        activeId: '1:2',
        anchor: { x: 100, y: 200 },
        display,
        cell: CELL,
        area: AREA
      })
    ).toEqual([
      { x: 100, y: 100 },
      { x: 100, y: 200 }
    ])
  })

  it('does not count the moving icons as obstacles', () => {
    expect(
      looseDropPositions({
        ids: ['1:1'],
        activeId: '1:1',
        anchor: { x: 0, y: 0 },
        display,
        cell: CELL,
        area: AREA
      })
    ).toEqual([{ x: 0, y: 0 }])
  })
})
