import type { Point, Rect } from './schema'

// Pure rectangle maths for the desktop canvas: groups, loose-icon slots, the marquee. Every
// coordinate is in the desktop window's CSS pixels (the display's DIPs, origin at the display's
// top-left), except `localWorkArea`'s input, which is in screen DIPs.

export interface Size {
  width: number
  height: number
}

/** Positions and sizes snap to this grid (CSS px) when Settings → grid snap is on. */
export const GRID_SNAP = 8

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** True when the rects overlap by some area; rects that only share an edge do not. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Half-open: the top and left edges are inside, the bottom and right edges are not. */
export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  )
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/** The rect spanned by two corners (a marquee dragged in any direction). */
export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Keeps the rect inside `area`: first shrinks it to fit, then moves it back in. Returns the same
 * object when it is already inside.
 */
export function clampRect(rect: Rect, area: Rect): Rect {
  const width = Math.min(rect.width, area.width)
  const height = Math.min(rect.height, area.height)
  const x = clamp(rect.x, area.x, area.x + area.width - width)
  const y = clamp(rect.y, area.y, area.y + area.height - height)
  if (x === rect.x && y === rect.y && width === rect.width && height === rect.height) return rect
  return { x, y, width, height }
}

export function snapValue(value: number, grid: number = GRID_SNAP): number {
  // `+ 0` turns -0 into 0.
  return Math.round(value / grid) * grid + 0
}

export function snapRect(rect: Rect, grid: number = GRID_SNAP): Rect {
  return {
    x: snapValue(rect.x, grid),
    y: snapValue(rect.y, grid),
    width: snapValue(rect.width, grid),
    height: snapValue(rect.height, grid)
  }
}

/** The grid cells of `area`, column-first from its top-left (the Windows desktop's order). */
function* cells(cell: Size, area: Rect): Generator<Rect> {
  const columns = Math.floor(area.width / cell.width)
  const rows = Math.floor(area.height / cell.height)
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      yield {
        x: area.x + column * cell.width,
        y: area.y + row * cell.height,
        width: cell.width,
        height: cell.height
      }
    }
  }
}

/**
 * The first grid cell of `area` (column-first from the top-left) that overlaps nothing in
 * `occupied`, or null when every cell is taken.
 */
export function firstFreeSlot(occupied: readonly Rect[], cell: Size, area: Rect): Point | null {
  for (const candidate of cells(cell, area)) {
    if (!occupied.some((rect) => rectsIntersect(rect, candidate))) {
      return { x: candidate.x, y: candidate.y }
    }
  }
  return null
}

/**
 * `count` free cells, each one marked taken before the next is chosen. Cells overlapping `near`
 * (e.g. a deleted group's rect) come first, then the rest of the area, column-first. When the area is
 * full the rest stack at its origin (visible and reachable, never lost off-screen).
 */
export function freeSlots(
  occupied: readonly Rect[],
  cell: Size,
  area: Rect,
  count: number,
  near?: Rect
): Point[] {
  const taken = [...occupied]
  const result: Point[] = []
  const pick = (accept: (candidate: Rect) => boolean): void => {
    for (const candidate of cells(cell, area)) {
      if (result.length === count) return
      if (!accept(candidate) || taken.some((rect) => rectsIntersect(rect, candidate))) continue
      taken.push(candidate)
      result.push({ x: candidate.x, y: candidate.y })
    }
  }
  if (near) pick((candidate) => rectsIntersect(candidate, near))
  pick(() => true)
  while (result.length < count) result.push({ x: area.x, y: area.y })
  return result
}

export interface HitTarget {
  id: string
  rect: Rect
  z: number
}

/** The id of the topmost (highest `z`) target containing the point, or null. */
export function hitTest(point: Point, targets: readonly HitTarget[]): string | null {
  let best: HitTarget | null = null
  for (const target of targets) {
    if (!rectContainsPoint(target.rect, point)) continue
    if (best === null || target.z > best.z) best = target
  }
  return best?.id ?? null
}

/** `start` moved by the pointer delta, snapped when asked, then clamped into `area`. */
export function moveRect(start: Rect, dx: number, dy: number, area: Rect, snap: boolean): Rect {
  const x = start.x + dx
  const y = start.y + dy
  const moved = {
    ...start,
    x: snap ? snapValue(x) : x,
    y: snap ? snapValue(y) : y
  }
  return clampRect(moved, area)
}

export interface ResizeOptions {
  min: Size
  area: Rect
  snap: boolean
}

/**
 * `start` with the dragged edges moved by the pointer delta, each moved edge passed through
 * `snapEdge` (its axis and raw position → where it goes), then stopped where the rect would get
 * smaller than `min` and never past the area's edge. The opposite edges stay where they are.
 */
export function resizeEdges(
  start: Rect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  min: Size,
  area: Rect,
  snapEdge: (axis: 'x' | 'y', value: number) => number
): Rect {
  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (edge.includes('e')) {
    right = clamp(snapEdge('x', right + dx), left + min.width, area.x + area.width)
  }
  if (edge.includes('w')) left = clamp(snapEdge('x', left + dx), area.x, right - min.width)
  if (edge.includes('s')) {
    bottom = clamp(snapEdge('y', bottom + dy), top + min.height, area.y + area.height)
  }
  if (edge.includes('n')) top = clamp(snapEdge('y', top + dy), area.y, bottom - min.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * `start` with the dragged edges moved by the pointer delta: a moved edge snaps to the grid when
 * asked, stops where the rect would get smaller than `min`, and never passes the area's edge.
 * The opposite edges stay where they are.
 */
export function resizeRect(
  start: Rect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  { min, area, snap }: ResizeOptions
): Rect {
  return resizeEdges(start, edge, dx, dy, min, area, (_axis, value) =>
    snap ? snapValue(value) : value
  )
}

/** The display's work area in its desktop window's coordinates (origin at the display's corner). */
export function localWorkArea(display: { bounds: Rect; workArea: Rect }): Rect {
  return {
    x: display.workArea.x - display.bounds.x,
    y: display.workArea.y - display.bounds.y,
    width: display.workArea.width,
    height: display.workArea.height
  }
}
