import { clampRect, resizeEdges, snapValue, type ResizeEdge, type Size } from './geometry'
import type { Rect } from './schema'

// Round 2: snapping while a group (or the tools widget) moves or resizes. Two kinds, per axis:
// - magnetic alignment: an edge (or the centre) within MAGNET_DISTANCE of another window's edge
//   (or centre), or of a work-area edge, is pulled onto it, and a guide line shows the alignment;
// - the grid (Settings › grid snap, step GRID_SIZES), which rules an axis no magnet pulled.
// Pure: every coordinate is in the desktop window's CSS pixels.

/** The grid steps Settings offers (px). */
export const GRID_SIZES = [8, 16, 32] as const
export type GridSize = (typeof GRID_SIZES)[number]

/** How close (px) an edge or centre must come to a line to be pulled onto it. */
export const MAGNET_DISTANCE = 8

/**
 * A guide line: `axis: 'x'` is a vertical line at x = `at` from y = `from` to `to`; `axis: 'y'`
 * a horizontal line at y = `at` from x = `from` to `to`.
 */
export interface SnapGuide {
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}

export interface SnapOptions {
  /** The work area: bounds the rect, and its edges attract. */
  area: Rect
  /** The other windows' rects on the display (never the one moving). */
  targets: readonly Rect[]
  /** Grid step, or null when grid snap is off. */
  grid: number | null
  /** Magnet reach; MAGNET_DISTANCE by default. */
  distance?: number
}

export interface Snapped {
  rect: Rect
  /** The alignments the final rect has, to draw while dragging. */
  guides: SnapGuide[]
}

type Axis = 'x' | 'y'

/** A line one rect offers on an axis, and the span it covers on the other axis. */
interface Line {
  at: number
  kind: 'edge' | 'centre'
  from: number
  to: number
}

function lowOf(rect: Rect, axis: Axis): number {
  return axis === 'x' ? rect.x : rect.y
}

function length(rect: Rect, axis: Axis): number {
  return axis === 'x' ? rect.width : rect.height
}

function across(rect: Rect, axis: Axis): [number, number] {
  return axis === 'x' ? [rect.y, rect.y + rect.height] : [rect.x, rect.x + rect.width]
}

/** The lines on `axis` that attract: every target's edges and centre, and the area's edges. */
function linesOf(axis: Axis, { targets, area }: SnapOptions): Line[] {
  const lines: Line[] = []
  for (const target of targets) {
    const a = lowOf(target, axis)
    const size = length(target, axis)
    const [from, to] = across(target, axis)
    lines.push({ at: a, kind: 'edge', from, to })
    lines.push({ at: a + size / 2, kind: 'centre', from, to })
    lines.push({ at: a + size, kind: 'edge', from, to })
  }
  const [from, to] = across(area, axis)
  lines.push({ at: lowOf(area, axis), kind: 'edge', from, to })
  lines.push({ at: lowOf(area, axis) + length(area, axis), kind: 'edge', from, to })
  return lines
}

/**
 * The nearest line within reach of any of `probes` (a probe matches lines of its kind), as the
 * shift that puts that probe on it; null when none is in reach.
 */
function pull(
  probes: ReadonlyArray<{ at: number; kind: Line['kind'] }>,
  lines: readonly Line[],
  distance: number
): number | null {
  let best: number | null = null
  for (const probe of probes) {
    for (const line of lines) {
      if (line.kind !== probe.kind) continue
      const shift = line.at - probe.at
      if (Math.abs(shift) <= distance && (best === null || Math.abs(shift) < Math.abs(best))) {
        best = shift
      }
    }
  }
  return best
}

/** Guides for the lines `rect` lies on (edges on edges, centre on centres), merged per line. */
function guidesFor(
  rect: Rect,
  axis: Axis,
  lines: readonly Line[],
  probes: ReadonlyArray<'start' | 'centre' | 'end'>
): SnapGuide[] {
  const a = lowOf(rect, axis)
  const size = length(rect, axis)
  const [from, to] = across(rect, axis)
  const own: Array<{ at: number; kind: Line['kind'] }> = probes.map((probe) =>
    probe === 'centre'
      ? { at: a + size / 2, kind: 'centre' }
      : { at: probe === 'end' ? a + size : a, kind: 'edge' }
  )
  const merged = new Map<number, SnapGuide>()
  for (const line of lines) {
    if (!own.some((probe) => probe.kind === line.kind && Math.abs(probe.at - line.at) < 0.5)) {
      continue
    }
    const known = merged.get(line.at)
    merged.set(line.at, {
      axis,
      at: line.at,
      from: Math.min(known?.from ?? Infinity, from, line.from),
      to: Math.max(known?.to ?? -Infinity, to, line.to)
    })
  }
  return [...merged.values()]
}

/**
 * `start` moved by the pointer delta: per axis, its edges or centre pulled onto the nearest line
 * within reach (other windows' edges/centres, the work area's edges); otherwise snapped to the
 * grid when there is one; then clamped into the area.
 */
export function snapMove(start: Rect, dx: number, dy: number, options: SnapOptions): Snapped {
  const distance = options.distance ?? MAGNET_DISTANCE
  const raw = { ...start, x: start.x + dx, y: start.y + dy }
  const place = (axis: Axis): number => {
    const a = axis === 'x' ? raw.x : raw.y
    const size = length(raw, axis)
    const shift = pull(
      [
        { at: a, kind: 'edge' },
        { at: a + size / 2, kind: 'centre' },
        { at: a + size, kind: 'edge' }
      ],
      linesOf(axis, options),
      distance
    )
    if (shift !== null) return a + shift
    return options.grid === null ? a : snapValue(a, options.grid)
  }
  const rect = clampRect({ ...raw, x: place('x'), y: place('y') }, options.area)
  const all = ['start', 'centre', 'end'] as const
  return {
    rect,
    guides: [
      ...guidesFor(rect, 'x', linesOf('x', options), all),
      ...guidesFor(rect, 'y', linesOf('y', options), all)
    ]
  }
}

/**
 * `start` with the dragged edges moved by the pointer delta: each dragged edge is pulled onto the
 * nearest edge within reach (other windows', the work area's), otherwise snapped to the grid when
 * there is one; it stops at `min` and at the area's edges. The other edges stay.
 */
export function snapResize(
  start: Rect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  options: SnapOptions & { min: Size }
): Snapped {
  const distance = options.distance ?? MAGNET_DISTANCE
  const lines = { x: linesOf('x', options), y: linesOf('y', options) }
  const snapEdge = (axis: Axis, value: number): number => {
    const shift = pull([{ at: value, kind: 'edge' }], lines[axis], distance)
    if (shift !== null) return value + shift
    return options.grid === null ? value : snapValue(value, options.grid)
  }
  const rect = resizeEdges(start, edge, dx, dy, options.min, options.area, snapEdge)
  const probes = (axis: Axis): Array<'start' | 'end'> => {
    const [low, high] = axis === 'x' ? (['w', 'e'] as const) : (['n', 's'] as const)
    return [
      ...(edge.includes(low) ? ['start' as const] : []),
      ...(edge.includes(high) ? ['end' as const] : [])
    ]
  }
  return {
    rect,
    guides: [
      ...guidesFor(rect, 'x', lines.x, probes('x')),
      ...guidesFor(rect, 'y', lines.y, probes('y'))
    ]
  }
}
