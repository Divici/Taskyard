import { describe, expect, it } from 'vitest'
import { GRID_SIZES, MAGNET_DISTANCE, snapMove, snapResize } from './snapping'

const AREA = { x: 0, y: 0, width: 1920, height: 1032 }
const MIN = { width: 160, height: 120 }
// A neighbour: left 400, centre 540, right 680; top 100, middle 200, bottom 300.
const OTHER = { x: 400, y: 100, width: 280, height: 200 }
const START = { x: 1000, y: 600, width: 200, height: 160 }

describe('snapping constants', () => {
  it('offers 8 / 16 / 32 px grids and an 8 px magnet', () => {
    expect(GRID_SIZES).toEqual([8, 16, 32])
    expect(MAGNET_DISTANCE).toBe(8)
  })
})

describe('snapMove', () => {
  it('without targets or grid it is the plain move, clamped into the area', () => {
    expect(snapMove(START, -13, 7, { area: AREA, targets: [], grid: null })).toEqual({
      rect: { x: 987, y: 607, width: 200, height: 160 },
      guides: []
    })
    expect(snapMove(START, 5000, 5000, { area: AREA, targets: [], grid: null }).rect).toEqual({
      x: 1720,
      y: 872,
      width: 200,
      height: 160
    })
  })

  it('snaps to the grid step it is given when no edge is near', () => {
    const options = { area: AREA, targets: [], grid: 16 }
    expect(snapMove(START, -13, 7, options).rect).toMatchObject({ x: 992, y: 608 })
    expect(snapMove(START, -13, 7, { ...options, grid: 32 }).rect).toMatchObject({
      x: 992,
      y: 608
    })
    expect(snapMove(START, -21, 7, { ...options, grid: 8 }).rect).toMatchObject({
      x: 976,
      y: 608
    })
  })

  it('pulls its left edge onto another group’s right edge within 8 px, with a vertical guide', () => {
    // Left edge would land at 686: 6 px from the neighbour's right edge (680).
    const { rect, guides } = snapMove(START, -314, -497, {
      area: AREA,
      targets: [OTHER],
      grid: 16
    })
    expect(rect).toMatchObject({ x: 680 })
    expect(guides).toContainEqual({ axis: 'x', at: 680, from: 100, to: 300 })
  })

  it('aligns tops, bottoms and centres too (the grid only rules an axis with no magnet)', () => {
    // Top at 104 → 100 (the neighbour's top); x far from everything → grid.
    const top = snapMove(START, -203, -496, { area: AREA, targets: [OTHER], grid: 16 })
    expect(top.rect).toMatchObject({ x: 800, y: 100 })
    // A horizontal guide at y 100 across both groups.
    expect(top.guides).toEqual([{ axis: 'y', at: 100, from: 400, to: 1000 }])

    // Centre 545 → 540 (the neighbour's centre): x = 440.
    const centre = snapMove(START, -555, -200, { area: AREA, targets: [OTHER], grid: null })
    expect(centre.rect).toMatchObject({ x: 440, y: 400 })
    expect(centre.guides).toContainEqual({ axis: 'x', at: 540, from: 100, to: 560 })
  })

  it('takes the nearest line when several are in reach, and ignores lines past 8 px', () => {
    // Right edge at 395 (5 px from 400) and left edge at 195: the right edge wins.
    const near = snapMove(START, -805, 0, { area: AREA, targets: [OTHER], grid: null })
    expect(near.rect.x).toBe(200)
    // 9 px away: no pull.
    const far = snapMove(START, -309, 0, { area: AREA, targets: [OTHER], grid: null })
    expect(far.rect.x).toBe(691)
    expect(far.guides).toEqual([])
  })

  it('snaps to the work area’s edges', () => {
    const { rect, guides } = snapMove(START, -995, 0, { area: AREA, targets: [], grid: null })
    expect(rect.x).toBe(0)
    expect(guides).toEqual([{ axis: 'x', at: 0, from: 0, to: 1032 }])
    const bottom = snapMove(START, 0, 266, { area: { ...AREA, y: 40 }, targets: [], grid: null })
    // Area bottom 1072: the bottom edge 1026 is 46 px away → no pull; 1066 is 6 px → pulled.
    expect(bottom.rect.y).toBe(866)
    expect(
      snapMove(START, 0, 306, { area: { ...AREA, y: 40 }, targets: [], grid: null }).rect.y
    ).toBe(912)
  })
})

describe('snapResize', () => {
  it('without targets it is the grid resize, stopping at the minimum and the area', () => {
    expect(
      snapResize(START, 'se', 21, 13, { area: AREA, targets: [], grid: 16, min: MIN }).rect
    ).toEqual({ x: 1000, y: 600, width: 216, height: 168 })
    expect(
      snapResize(START, 'nw', 900, 900, { area: AREA, targets: [], grid: null, min: MIN }).rect
    ).toEqual({ x: 1040, y: 640, width: 160, height: 120 })
    expect(
      snapResize(START, 'e', 5000, 0, { area: AREA, targets: [], grid: null, min: MIN }).rect
    ).toMatchObject({ width: 920 })
  })

  it('pulls the dragged edge onto a nearby edge, with a guide; the other edges stay', () => {
    const below = { x: 1100, y: 900, width: 300, height: 100 }
    // East edge 1200 → 1395 would be 5 px short of below's right edge (1400).
    const { rect, guides } = snapResize(START, 'e', 195, 0, {
      area: AREA,
      targets: [below],
      grid: 16,
      min: MIN
    })
    expect(rect).toEqual({ x: 1000, y: 600, width: 400, height: 160 })
    expect(guides).toEqual([{ axis: 'x', at: 1400, from: 600, to: 1000 }])

    // North edge 600 → 305: 5 px below the neighbour's bottom (300).
    const north = snapResize(START, 'n', 0, -295, {
      area: AREA,
      targets: [OTHER],
      grid: null,
      min: MIN
    })
    expect(north.rect).toEqual({ x: 1000, y: 300, width: 200, height: 460 })
  })
})
