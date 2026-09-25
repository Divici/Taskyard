import { rectsIntersect, type Size } from './geometry'
import { forgetItemIds } from './layout-ids'
import { moveItems, type MoveTarget } from './layout-mutations'
import type { DisplayLayout, LayoutFile, Point, Rect } from './schema'

// Where dropped items go (Phase 8): placing them on one display, remembering and restoring where
// they were (Explorer-drop Undo), and the grid cells a drop onto the desktop uses. Pure changes
// over the layout as it is when applied (see layout-mutations.ts for the replay rules).

/**
 * Places `ids` on `displayId` at `target` (a group before an anchor, or loose positions) and
 * removes them from every *other* display first, so an item another window placed meanwhile
 * (e.g. reconcile placing a file an Explorer drop just moved in) ends up in exactly one place.
 * Same object when nothing changes.
 */
export function placeItems(
  layout: LayoutFile,
  displayId: number,
  ids: readonly string[],
  target: MoveTarget
): LayoutFile {
  if (ids.length === 0) return layout
  const moving = new Set(ids)
  let changed = false
  const displays = layout.displays.map((display) => {
    if (display.displayId === displayId) return display
    const loose = Object.fromEntries(
      Object.entries(display.loose).filter(([id]) => !moving.has(id))
    )
    const looseChanged = Object.keys(loose).length !== Object.keys(display.loose).length
    const groups = display.groups.map((group) =>
      group.items.some((id) => moving.has(id))
        ? { ...group, items: group.items.filter((id) => !moving.has(id)) }
        : group
    )
    const groupsChanged = groups.some((group, index) => group !== display.groups[index])
    if (!looseChanged && !groupsChanged) return display
    changed = true
    return { ...display, loose: looseChanged ? loose : display.loose, groups }
  })
  const cleared = changed ? { ...layout, displays } : layout
  return moveItems(cleared, displayId, ids, target)
}

/** Where one item was: in a group before `beforeId` (null = at the end), loose, or nowhere. */
export interface ItemPlacement {
  id: string
  displayId: number | null
  at: { groupId: string; beforeId: string | null } | { loose: Point } | null
}

/**
 * Where each id is now. A grouped id's anchor is the next item after it that is *not* among
 * `ids`, so restoring a run of neighbours puts them back together in their old order.
 */
export function placementsOf(layout: LayoutFile, ids: readonly string[]): ItemPlacement[] {
  const moving = new Set(ids)
  return ids.map((id) => {
    for (const display of layout.displays) {
      const point = display.loose[id]
      if (point) return { id, displayId: display.displayId, at: { loose: { ...point } } }
      for (const group of display.groups) {
        const index = group.items.indexOf(id)
        if (index === -1) continue
        const beforeId = group.items.slice(index + 1).find((next) => !moving.has(next)) ?? null
        return { id, displayId: display.displayId, at: { groupId: group.id, beforeId } }
      }
    }
    return { id, displayId: null, at: null }
  })
}

/**
 * Puts every id of `snapshot` back where `placementsOf` found it; ids that were nowhere are
 * forgotten. Grouped ids sharing an anchor move together, so their old order is kept.
 */
export function restorePlacements(
  layout: LayoutFile,
  snapshot: readonly ItemPlacement[]
): LayoutFile {
  let next = forgetItemIds(
    layout,
    snapshot.filter((entry) => entry.at === null).map((entry) => entry.id)
  )
  // Grouped: one move per (display, group, anchor), ids in their snapshot order.
  const runs = new Map<string, { displayId: number; target: MoveTarget; ids: string[] }>()
  for (const entry of snapshot) {
    if (entry.at === null || entry.displayId === null) continue
    if ('loose' in entry.at) {
      next = placeItems(next, entry.displayId, [entry.id], { loose: [entry.at.loose] })
      continue
    }
    const key = JSON.stringify([entry.displayId, entry.at.groupId, entry.at.beforeId])
    const run = runs.get(key) ?? {
      displayId: entry.displayId,
      target: { groupId: entry.at.groupId, beforeId: entry.at.beforeId },
      ids: []
    }
    run.ids.push(entry.id)
    runs.set(key, run)
  }
  for (const run of runs.values()) next = placeItems(next, run.displayId, run.ids, run.target)
  return next
}

/**
 * The loose-icon grid cell (anchored at the work area's corner) whose centre is nearest `point`,
 * kept inside the area.
 */
export function cellAt(point: Point, cell: Size, area: Rect): Point {
  const columns = Math.max(1, Math.floor(area.width / cell.width))
  const rows = Math.max(1, Math.floor(area.height / cell.height))
  const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max - 1)
  const column = clamp(Math.round((point.x - area.x - cell.width / 2) / cell.width), columns)
  const row = clamp(Math.round((point.y - area.y - cell.height / 2) / cell.height), rows)
  return { x: area.x + column * cell.width, y: area.y + row * cell.height }
}

export interface LooseDropInput {
  /** The dropped ids, in the order they keep. */
  ids: readonly string[]
  /** The item under the pointer (lands on `anchor` when the arrangement is kept). */
  activeId: string
  /** The grid cell the drop points at (`cellAt`). */
  anchor: Point
  display: Pick<DisplayLayout, 'groups' | 'loose'>
  cell: Size
  area: Rect
}

/**
 * Where dropped items land on the desktop, never on a group or another icon:
 * - loose icons moved together keep their arrangement, shifted so the grabbed one lands on the
 *   anchor (an icon whose shifted cell is taken or off the area takes the next free cell);
 * - otherwise the items fill free cells column-first from the anchor, in order.
 */
export function looseDropPositions({
  ids,
  activeId,
  anchor,
  display,
  cell,
  area
}: LooseDropInput): Point[] {
  const moving = new Set(ids)
  const taken: Rect[] = [
    ...display.groups.map((group) => ({ x: group.x, y: group.y, width: group.w, height: group.h })),
    ...Object.entries(display.loose)
      .filter(([id]) => !moving.has(id))
      .map(([, point]) => ({ ...point, ...cell }))
  ]
  const columns = Math.max(1, Math.floor(area.width / cell.width))
  const rows = Math.max(1, Math.floor(area.height / cell.height))
  const total = columns * rows
  const indexOf = (point: Point): number =>
    Math.round((point.x - area.x) / cell.width) * rows +
    Math.round((point.y - area.y) / cell.height)
  const pointOf = (index: number): Point => ({
    x: area.x + Math.floor(index / rows) * cell.width,
    y: area.y + (index % rows) * cell.height
  })
  const free = (point: Point): boolean => {
    const rect = { ...point, ...cell }
    return !taken.some((other) => rectsIntersect(other, rect))
  }
  const inside = (point: Point): boolean =>
    point.x >= area.x &&
    point.y >= area.y &&
    point.x + cell.width <= area.x + area.width &&
    point.y + cell.height <= area.y + area.height
  const take = (point: Point): Point => {
    taken.push({ ...point, ...cell })
    return point
  }
  /** The first free cell at or after `start` (column-first, wrapping); the area's corner if full. */
  const nextFree = (start: Point): Point => {
    const first = Math.min(Math.max(indexOf(start), 0), total - 1)
    for (let step = 0; step < total; step++) {
      const candidate = pointOf((first + step) % total)
      if (free(candidate)) return take(candidate)
    }
    return take({ x: area.x, y: area.y })
  }

  const origin = display.loose[activeId]
  const allLoose = origin !== undefined && ids.every((id) => display.loose[id] !== undefined)
  if (allLoose) {
    const dx = anchor.x - origin.x
    const dy = anchor.y - origin.y
    const wanted = ids.map((id) => ({ x: display.loose[id].x + dx, y: display.loose[id].y + dy }))
    // Cells that are free keep their icon first; the rest look for the next free cell after.
    const result: Array<Point | null> = wanted.map((point) =>
      inside(point) && free(point) ? take(point) : null
    )
    return result.map((point, index) => point ?? nextFree(wanted[index]))
  }

  let cursor = anchor
  return ids.map(() => {
    const point = nextFree(cursor)
    cursor = point
    return point
  })
}
