import { freeSlots, type Size } from './geometry'
import { forgetItemIds } from './layout-ids'
import { updateDisplay, type LooseSlots } from './layout-mutations'
import type { DisplayLayout, LayoutFile, Point, Rect } from './schema'

// Where desktop items go: reconciling the layout with what is on disk, placing new items in the
// first free grid slot, and laying loose icons out again. All pure changes over the layout as it
// is when applied (see layout-mutations.ts for the replay rules).

/** A missing id is forgotten once it has been missing this long (30 days). */
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

/** An item on the desktop right now (from main's scan). */
export interface PresentItem {
  id: string
  path: string
  /** Sorts new items by name, like Explorer. */
  name: string
}

/** Where new items are placed: the primary display's work area, in its window's coordinates. */
export interface PlaceTarget {
  displayId: number
  area: Rect
  cell: Size
}

export interface ReconcileOptions {
  now: number
  /** Null: record and hide only; place nothing (e.g. the display is not known yet). */
  place: PlaceTarget | null
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Every file id the layout places, on any display. */
export function placedIds(layout: LayoutFile): Set<string> {
  const ids = new Set<string>()
  for (const display of layout.displays) {
    for (const id of Object.keys(display.loose)) ids.add(id)
    for (const group of display.groups) for (const id of group.items) ids.add(id)
  }
  return ids
}

/** What a new loose icon must not land on: the groups and the other icons' cells. */
function occupiedRects(display: DisplayLayout, cell: Size, skipGroupId?: string): Rect[] {
  return [
    ...display.groups
      .filter((group) => group.id !== skipGroupId)
      .map((group) => ({ x: group.x, y: group.y, width: group.w, height: group.h })),
    ...Object.values(display.loose).map((point) => ({ ...point, ...cell }))
  ]
}

/**
 * Places the items no display places yet as loose icons on `place.displayId`, sorted by name,
 * each in the first free cell (column-first) of the work area, and records their paths. Items
 * already placed anywhere are left alone. Same object when nothing is placed.
 */
export function placeNewItems(
  layout: LayoutFile,
  items: readonly PresentItem[],
  place: PlaceTarget
): LayoutFile {
  const placed = placedIds(layout)
  const fresh = items
    .filter((item) => !placed.has(item.id))
    .sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.id, b.id))
  if (fresh.length === 0) return layout

  const next = updateDisplay(layout, place.displayId, (display) => {
    const slots = freeSlots(
      occupiedRects(display, place.cell),
      place.cell,
      place.area,
      fresh.length
    )
    const loose = { ...display.loose }
    fresh.forEach((item, index) => {
      loose[item.id] = slots[index]
    })
    return { ...display, loose }
  })
  if (next === layout) return layout
  const paths = { ...next.paths }
  for (const item of fresh) paths[item.id] = item.path
  return { ...next, paths }
}

/**
 * Brings the layout in line with the items on disk:
 * - a known id (placed, or with a path or stamp) that is missing gets `lastSeen[id] = now` once,
 *   and keeps its placement (it is not rendered, because it is not an item);
 * - a present id clears its stamp, and a placed one follows a path that changed while closed;
 * - an id missing for more than 30 days is forgotten everywhere;
 * - present ids placed nowhere are placed on `options.place` (see `placeNewItems`).
 * Same object when everything already agrees.
 */
export function reconcileLayout(
  layout: LayoutFile,
  present: readonly PresentItem[],
  options: ReconcileOptions
): LayoutFile {
  const presentById = new Map(present.map((item) => [item.id, item]))
  const placed = placedIds(layout)
  const known = new Set([...placed, ...Object.keys(layout.paths), ...Object.keys(layout.lastSeen)])

  let next = layout

  // Stamps: set for newly missing ids, cleared for returning ones.
  const lastSeen = { ...layout.lastSeen }
  let stampsChanged = false
  for (const id of known) {
    const missing = !presentById.has(id)
    if (missing && lastSeen[id] === undefined) {
      lastSeen[id] = options.now
      stampsChanged = true
    } else if (!missing && lastSeen[id] !== undefined) {
      delete lastSeen[id]
      stampsChanged = true
    }
  }
  if (stampsChanged) next = { ...next, lastSeen }

  // Paths of placed items that moved while Taskyard was closed.
  const renamed = [...presentById.values()].filter(
    (item) => placed.has(item.id) && next.paths[item.id] !== item.path
  )
  if (renamed.length > 0) {
    const paths = { ...next.paths }
    for (const item of renamed) paths[item.id] = item.path
    next = { ...next, paths }
  }

  // Long gone: forget.
  const expired = Object.entries(next.lastSeen)
    .filter(([, since]) => options.now - since > PRUNE_AFTER_MS)
    .map(([id]) => id)
  next = forgetItemIds(next, expired)

  if (options.place) next = placeNewItems(next, present, options.place)
  return next
}

/**
 * Lays the display's loose icons out again, column-first around the groups, in `order` (ids not
 * in it follow, in their current order). Only ids loose on the display when this is applied
 * move. Same object when nothing moves.
 */
export function arrangeLoose(
  layout: LayoutFile,
  displayId: number,
  order: readonly string[],
  area: Rect,
  cell: Size
): LayoutFile {
  return updateDisplay(layout, displayId, (display) => {
    const current = Object.keys(display.loose)
    const rank = new Map(order.map((id, index) => [id, index]))
    const ids = [...current].sort(
      (a, b) =>
        (rank.get(a) ?? order.length + current.indexOf(a)) -
        (rank.get(b) ?? order.length + current.indexOf(b))
    )
    const slots = freeSlots(occupiedRects({ ...display, loose: {} }, cell), cell, area, ids.length)
    const loose: Record<string, Point> = {}
    ids.forEach((id, index) => {
      loose[id] = slots[index]
    })
    const same = ids.every(
      (id) => display.loose[id].x === loose[id].x && display.loose[id].y === loose[id].y
    )
    return same ? display : { ...display, loose }
  })
}

/**
 * `deleteGroup`'s slots: free cells under the deleted group's rect first, then the rest of the
 * work area (column-first), never on another group or loose icon.
 */
export function nearRectSlots(area: Rect, cell: Size): LooseSlots {
  return (group, count, display) =>
    freeSlots(occupiedRects(display, cell, group.id), cell, area, count, {
      x: group.x,
      y: group.y,
      width: group.w,
      height: group.h
    })
}
