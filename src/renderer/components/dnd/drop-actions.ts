import { cellAt, looseDropPositions } from '@shared/drop-placement'
import type { Size } from '@shared/geometry'
import type { GroupSort, Point, Rect } from '@shared/schema'
import { useLayoutStore } from '../../stores/layout'
import type { DropHint } from '../../stores/ui'
import { resolveGroupDrop } from './group-drop'

/** Where dropped items go on this display. */
export type DropTarget =
  | { kind: 'group'; groupId: string; index: number | null; beforeId: string | null }
  | { kind: 'canvas'; anchor: Point }

/** The display a drop lands on, in its window's coordinates. */
export interface DropPlace {
  displayId: number
  area: Rect
  cell: Size
}

export function groupTarget(
  groupId: string,
  sort: GroupSort,
  body: HTMLElement | null,
  point: Point
): DropTarget {
  return { kind: 'group', groupId, ...resolveGroupDrop(body, point, sort) }
}

/** A drop on the desktop: the loose grid cell nearest the pointer. */
export function canvasTarget(point: Point, place: Pick<DropPlace, 'area' | 'cell'>): DropTarget {
  return { kind: 'canvas', anchor: cellAt(point, place.cell, place.area) }
}

export function hintOf(target: DropTarget): DropHint {
  return target.kind === 'group'
    ? { kind: 'group', groupId: target.groupId, index: target.index }
    : { kind: 'canvas', point: target.anchor }
}

/**
 * Puts `ids` (in the order they keep) at `target` on the display — one layout change:
 * - a `manual` group inserts them before the anchor; other sorts append and re-sort (a drop back
 *   into the same sorted group changes nothing);
 * - the desktop takes them at free grid cells from the anchor (see `looseDropPositions`).
 * They leave every other display too (an Explorer drop's file may already be placed elsewhere).
 */
export function dropItems(
  place: DropPlace,
  ids: readonly string[],
  activeId: string,
  target: DropTarget
): void {
  const store = useLayoutStore.getState()
  const display = store.layout.displays.find((entry) => entry.displayId === place.displayId)
  if (!display || ids.length === 0) return
  if (target.kind === 'group') {
    const group = display.groups.find((entry) => entry.id === target.groupId)
    if (!group) return
    const manual = group.sort === 'manual'
    if (!manual && ids.every((id) => group.items.includes(id))) return
    store.placeItems(place.displayId, [...ids], {
      groupId: group.id,
      beforeId: manual ? target.beforeId : null
    })
    return
  }
  const positions = looseDropPositions({
    ids,
    activeId,
    anchor: target.anchor,
    display,
    cell: place.cell,
    area: place.area
  })
  store.placeItems(place.displayId, [...ids], { loose: positions })
}
