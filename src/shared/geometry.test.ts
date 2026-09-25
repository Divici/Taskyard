import { describe, expect, it } from 'vitest'
import {
  clampRect,
  firstFreeSlot,
  freeSlots,
  hitTest,
  localWorkArea,
  moveRect,
  normalizeRect,
  rectCenter,
  rectContainsPoint,
  rectsIntersect,
  resizeRect,
  snapRect,
  snapValue
} from './geometry'

const AREA = { x: 0, y: 0, width: 1000, height: 600 }
const CELL = { width: 100, height: 100 }

describe('rectsIntersect', () => {
  it('is true for overlapping rects and false for rects that only touch or are apart', () => {
    const a = { x: 0, y: 0, width: 100, height: 100 }
    expect(rectsIntersect(a, { x: 50, y: 50, width: 100, height: 100 })).toBe(true)
    expect(rectsIntersect(a, { x: 10, y: 10, width: 10, height: 10 })).toBe(true)
    expect(rectsIntersect(a, { x: 100, y: 0, width: 50, height: 50 })).toBe(false)
    expect(rectsIntersect(a, { x: 0, y: 200, width: 50, height: 50 })).toBe(false)
  })
})

describe('rectContainsPoint / rectCenter / normalizeRect', () => {
  it('contains points on the top-left edge, not the bottom-right one', () => {
    const r = { x: 10, y: 10, width: 20, height: 20 }
    expect(rectContainsPoint(r, { x: 10, y: 10 })).toBe(true)
    expect(rectContainsPoint(r, { x: 29, y: 29 })).toBe(true)
    expect(rectContainsPoint(r, { x: 30, y: 15 })).toBe(false)
    expect(rectCenter(r)).toEqual({ x: 20, y: 20 })
  })

  it('builds a rect from two corners dragged in any direction', () => {
    expect(normalizeRect({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: 40,
      height: 60
    })
  })
})

describe('clampRect', () => {
  it('leaves a rect inside the area untouched (same object)', () => {
    const r = { x: 10, y: 10, width: 200, height: 100 }
    expect(clampRect(r, AREA)).toBe(r)
  })

  it('pushes a rect back inside on every edge', () => {
    expect(clampRect({ x: -40, y: -10, width: 200, height: 100 }, AREA)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100
    })
    expect(clampRect({ x: 900, y: 550, width: 200, height: 100 }, AREA)).toEqual({
      x: 800,
      y: 500,
      width: 200,
      height: 100
    })
  })

  it('shrinks a rect larger than the area to fit it', () => {
    expect(clampRect({ x: 5, y: 5, width: 2000, height: 900 }, AREA)).toEqual(AREA)
  })

  it('respects an area that does not start at the origin (a taskbar on the top or left)', () => {
    const area = { x: 48, y: 40, width: 500, height: 400 }
    expect(clampRect({ x: 0, y: 0, width: 100, height: 100 }, area)).toEqual({
      x: 48,
      y: 40,
      width: 100,
      height: 100
    })
  })
})

describe('snap', () => {
  it('rounds to the nearest multiple of the grid (8 by default)', () => {
    expect(snapValue(11)).toBe(8)
    expect(snapValue(12)).toBe(16)
    expect(snapValue(-3)).toBe(0)
    expect(snapValue(17, 10)).toBe(20)
  })

  it('snaps position and size of a rect', () => {
    expect(snapRect({ x: 13, y: 21, width: 283, height: 197 })).toEqual({
      x: 16,
      y: 24,
      width: 280,
      height: 200
    })
  })
})

describe('firstFreeSlot', () => {
  it('fills column-first from the top-left, like the Windows desktop', () => {
    expect(firstFreeSlot([], CELL, AREA)).toEqual({ x: 0, y: 0 })
    const column = [0, 100, 200, 300, 400, 500].map((y) => ({ x: 0, y, width: 100, height: 100 }))
    // The first column (6 rows of 100 in 600) is full: next is the top of column two.
    expect(firstFreeSlot(column, CELL, AREA)).toEqual({ x: 100, y: 0 })
    expect(firstFreeSlot(column.slice(0, 2), CELL, AREA)).toEqual({ x: 0, y: 200 })
  })

  it('skips cells covered by anything occupied, even partly (a group, an icon off the grid)', () => {
    const group = { x: 0, y: 0, width: 150, height: 250 }
    expect(firstFreeSlot([group], CELL, AREA)).toEqual({ x: 0, y: 300 })
    const offGrid = { x: 50, y: 350, width: 100, height: 100 }
    expect(firstFreeSlot([group, offGrid], CELL, AREA)).toEqual({ x: 0, y: 500 })
  })

  it('starts at the work area origin and returns null when every cell is taken', () => {
    const area = { x: 48, y: 0, width: 200, height: 200 }
    expect(firstFreeSlot([], CELL, area)).toEqual({ x: 48, y: 0 })
    expect(firstFreeSlot([area], CELL, area)).toBeNull()
  })
})

describe('freeSlots', () => {
  it('returns distinct free cells, each one taken before looking for the next', () => {
    expect(freeSlots([], CELL, AREA, 3)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 0, y: 200 }
    ])
  })

  it('prefers cells inside `near` (a deleted group’s rect), then the rest of the area', () => {
    const near = { x: 300, y: 100, width: 200, height: 100 }
    const occupied = [{ x: 300, y: 100, width: 100, height: 100 }]
    expect(freeSlots(occupied, CELL, AREA, 3, near)).toEqual([
      { x: 400, y: 100 },
      { x: 0, y: 0 },
      { x: 0, y: 100 }
    ])
  })

  it('stacks the overflow at the area origin when the area is full', () => {
    const area = { x: 0, y: 0, width: 100, height: 100 }
    expect(freeSlots([], CELL, area, 2)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 }
    ])
  })
})

describe('hitTest', () => {
  it('returns the topmost (highest z) target under the point, or null', () => {
    const targets = [
      { id: 'low', rect: { x: 0, y: 0, width: 100, height: 100 }, z: 1 },
      { id: 'high', rect: { x: 50, y: 50, width: 100, height: 100 }, z: 5 }
    ]
    expect(hitTest({ x: 60, y: 60 }, targets)).toBe('high')
    expect(hitTest({ x: 10, y: 10 }, targets)).toBe('low')
    expect(hitTest({ x: 500, y: 500 }, targets)).toBeNull()
  })
})

describe('moveRect', () => {
  const start = { x: 100, y: 100, width: 280, height: 200 }

  it('moves by the pointer delta, snapped to 8 when asked, and clamped into the area', () => {
    expect(moveRect(start, 13, 5, AREA, false)).toEqual({ ...start, x: 113, y: 105 })
    expect(moveRect(start, 13, 5, AREA, true)).toEqual({ ...start, x: 112, y: 104 })
    expect(moveRect(start, -500, 900, AREA, true)).toEqual({ ...start, x: 0, y: 400 })
  })
})

describe('resizeRect', () => {
  const start = { x: 100, y: 100, width: 280, height: 200 }
  const opts = { min: { width: 160, height: 120 }, area: AREA, snap: false }

  it('moves only the dragged edges', () => {
    expect(resizeRect(start, 'se', 40, 30, opts)).toEqual({ ...start, width: 320, height: 230 })
    expect(resizeRect(start, 'w', -20, 99, opts)).toEqual({ ...start, x: 80, width: 300 })
    expect(resizeRect(start, 'n', 99, 20, opts)).toEqual({ ...start, y: 120, height: 180 })
  })

  it('stops at the minimum size, keeping the opposite edge in place', () => {
    expect(resizeRect(start, 'se', -500, -500, opts)).toEqual({
      ...start,
      width: 160,
      height: 120
    })
    expect(resizeRect(start, 'nw', 500, 500, opts)).toEqual({
      x: 220,
      y: 180,
      width: 160,
      height: 120
    })
  })

  it('never grows past the work area', () => {
    expect(resizeRect(start, 'e', 5000, 0, opts)).toEqual({ ...start, width: 900 })
    expect(resizeRect(start, 'nw', -5000, -5000, opts)).toEqual({
      x: 0,
      y: 0,
      width: 380,
      height: 300
    })
  })

  it('snaps the dragged edge to the 8 px grid when asked', () => {
    expect(resizeRect(start, 'se', 43, 29, { ...opts, snap: true })).toEqual({
      ...start,
      width: 324,
      height: 228
    })
  })
})

describe('localWorkArea', () => {
  it('turns the work area (screen DIPs) into window coordinates', () => {
    expect(
      localWorkArea({
        bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
        workArea: { x: 2560, y: 0, width: 1920, height: 1032 }
      })
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1032 })
  })
})
