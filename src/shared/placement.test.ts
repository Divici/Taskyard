import { describe, expect, it } from 'vitest'
import { emptyLayout, newDisplayLayout } from './defaults'
import {
  PRUNE_AFTER_MS,
  arrangeLoose,
  nearRectSlots,
  placeNewItems,
  reconcileLayout,
  type PlaceTarget,
  type PresentItem
} from './placement'
import { deleteGroup } from './layout-mutations'
import type { Group, LayoutFile } from './schema'

const PRIMARY = { x: 0, y: 0, width: 2560, height: 1440 }
const SECONDARY = { x: 2560, y: 0, width: 1920, height: 1080 }
const AREA = { x: 0, y: 0, width: 400, height: 300 }
const CELL = { width: 100, height: 100 }
const PLACE: PlaceTarget = { displayId: 1, area: AREA, cell: CELL }
const NOW = 1_760_000_000_000
const DAY = 24 * 60 * 60 * 1000

function group(id: string, patch: Partial<Group> = {}): Group {
  return {
    id,
    title: id,
    x: 200,
    y: 0,
    w: 200,
    h: 200,
    z: 1,
    rolledUp: false,
    items: [],
    sort: 'manual',
    excludeFromQuickHide: false,
    createdAt: 1,
    ...patch
  }
}

function layoutWith(patch: Partial<LayoutFile> = {}, groups: Group[] = []): LayoutFile {
  return {
    ...emptyLayout(),
    displays: [{ ...newDisplayLayout(1, PRIMARY), groups }, newDisplayLayout(2, SECONDARY)],
    ...patch
  }
}

const item = (id: string, name = id): PresentItem => ({ id, name, path: `C:\\D\\${name}` })

describe('reconcileLayout', () => {
  it('stamps lastSeen once for a placed id that is missing, and keeps its placement', () => {
    const start = layoutWith()
    start.displays[0].loose = { '1:1': { x: 0, y: 0 } }
    start.paths = { '1:1': 'C:\\D\\a' }

    const once = reconcileLayout(start, [], { now: NOW, place: PLACE })
    expect(once.lastSeen).toEqual({ '1:1': NOW })
    expect(once.displays[0].loose).toEqual({ '1:1': { x: 0, y: 0 } })

    // Later runs keep the first stamp: nothing changes, same object.
    expect(reconcileLayout(once, [], { now: NOW + DAY, place: PLACE })).toBe(once)
  })

  it('clears lastSeen when the id is back', () => {
    const start = layoutWith({ lastSeen: { '1:1': NOW - DAY }, paths: { '1:1': 'C:\\D\\1:1' } })
    start.displays[0].loose = { '1:1': { x: 0, y: 0 } }
    const next = reconcileLayout(start, [item('1:1')], { now: NOW, place: PLACE })
    expect(next.lastSeen).toEqual({})
    expect(next.displays[0].loose).toEqual({ '1:1': { x: 0, y: 0 } })
  })

  it('forgets an id missing for more than 30 days (groups, loose, paths, lastSeen)', () => {
    const start = layoutWith(
      {
        lastSeen: { '1:1': NOW - PRUNE_AFTER_MS - 1, '1:2': NOW - PRUNE_AFTER_MS },
        paths: { '1:1': 'C:\\D\\a', '1:2': 'C:\\D\\b' }
      },
      [group('g', { items: ['1:1', '1:2'] })]
    )
    const next = reconcileLayout(start, [], { now: NOW, place: PLACE })
    expect(next.displays[0].groups[0].items).toEqual(['1:2'])
    expect(next.paths).toEqual({ '1:2': 'C:\\D\\b' })
    expect(next.lastSeen).toEqual({ '1:2': NOW - PRUNE_AFTER_MS })
  })

  it('places present ids that are placed nowhere, on the target display only', () => {
    const next = reconcileLayout(layoutWith(), [item('1:2', 'b'), item('1:1', 'a')], {
      now: NOW,
      place: PLACE
    })
    // Sorted by name, column-first from the work area's top-left.
    expect(next.displays[0].loose).toEqual({ '1:1': { x: 0, y: 0 }, '1:2': { x: 0, y: 100 } })
    expect(next.displays[1].loose).toEqual({})
    expect(next.paths).toEqual({ '1:1': 'C:\\D\\a', '1:2': 'C:\\D\\b' })
  })

  it('does not place anything without a target, and never moves an id placed on another display', () => {
    const start = layoutWith()
    start.displays[1].loose = { '1:1': { x: 5, y: 5 } }
    const next = reconcileLayout(start, [item('1:1'), item('1:2')], { now: NOW, place: null })
    expect(next.displays[0].loose).toEqual({})
    expect(next.displays[1].loose).toEqual({ '1:1': { x: 5, y: 5 } })
  })

  it('follows a path that changed while Taskyard was closed', () => {
    const start = layoutWith({ paths: { '1:1': 'C:\\D\\old' } })
    start.displays[0].loose = { '1:1': { x: 0, y: 0 } }
    expect(reconcileLayout(start, [item('1:1', 'new')], { now: NOW, place: PLACE }).paths).toEqual({
      '1:1': 'C:\\D\\new'
    })
  })

  it('returns the same object when everything already agrees', () => {
    const start = layoutWith({ paths: { '1:1': 'C:\\D\\1:1' } })
    start.displays[0].loose = { '1:1': { x: 0, y: 0 } }
    expect(reconcileLayout(start, [item('1:1')], { now: NOW, place: PLACE })).toBe(start)
  })
})

describe('placeNewItems', () => {
  it('skips cells covered by groups and loose icons', () => {
    const start = layoutWith({}, [group('g', { x: 0, y: 0, w: 100, h: 150 })])
    start.displays[0].loose = { '9:9': { x: 100, y: 0 } }
    const next = placeNewItems(start, [item('1:1')], PLACE)
    // Column 1 rows 0-1 are under the group; row 2 is free.
    expect(next.displays[0].loose['1:1']).toEqual({ x: 0, y: 200 })
  })

  it('ignores ids that are already placed and an unknown display', () => {
    const start = layoutWith({}, [group('g', { items: ['1:1'] })])
    expect(placeNewItems(start, [item('1:1')], PLACE)).toBe(start)
    expect(placeNewItems(start, [item('1:2')], { ...PLACE, displayId: 7 })).toBe(start)
  })
})

describe('arrangeLoose', () => {
  it('lays loose icons out again in the given order, around the groups', () => {
    const start = layoutWith({}, [group('g', { x: 0, y: 100, w: 100, h: 100 })])
    start.displays[0].loose = { a: { x: 300, y: 200 }, b: { x: 250, y: 20 }, c: { x: 5, y: 5 } }
    const next = arrangeLoose(start, 1, ['b', 'a', 'c'], AREA, CELL)
    expect(next.displays[0].loose).toEqual({
      b: { x: 0, y: 0 },
      a: { x: 0, y: 200 },
      c: { x: 100, y: 0 }
    })
  })

  it('puts loose ids missing from the order after the ordered ones', () => {
    const start = layoutWith()
    start.displays[0].loose = { z: { x: 300, y: 200 }, a: { x: 250, y: 20 } }
    const next = arrangeLoose(start, 1, ['a'], AREA, CELL)
    expect(next.displays[0].loose).toEqual({ a: { x: 0, y: 0 }, z: { x: 0, y: 100 } })
  })
})

describe('nearRectSlots (deleteGroup)', () => {
  it('drops a deleted group’s items into free cells under its old rect first', () => {
    const start = layoutWith({}, [
      group('g', { x: 200, y: 0, w: 200, h: 100, items: ['1:1', '1:2'] })
    ])
    start.displays[0].loose = { '9:9': { x: 200, y: 0 } }
    const next = deleteGroup(start, 1, 'g', nearRectSlots(AREA, CELL))
    expect(next.displays[0].groups).toEqual([])
    expect(next.displays[0].loose).toEqual({
      '9:9': { x: 200, y: 0 },
      '1:1': { x: 300, y: 0 },
      '1:2': { x: 0, y: 0 }
    })
  })
})
