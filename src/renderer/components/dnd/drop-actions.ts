import { cellAt, looseDropPositions } from '@shared/drop-placement'
import type { Size } from '@shared/geometry'
import type { GroupSort, Point, Rect } from '@shared/schema'
import { useLayoutStore } from '../../stores/layout'
import type { DropHint } from '../../stores/ui'
import { groupBodyIds, resolveGroupDrop } from './group-drop'

/** Where dropped items go on this display. */
export type DropTarget =
  | {
      kind: 'group'
      groupId: string
      index: number | null
      beforeId: string | null
      /** The group's icons in the order shown when dropped (a reorder starts from it). */
      shown: string[]
    }
  | { kind: 'canvas'; anchor: Point }

/** The display a drop lands on, in its window's coordinates. */
export interface DropPlace {
  displayId: number
  area: Rect
  cell: Size
}

/**
 * A drop on a group. `reorder`: every dragged icon already is in this group, so the drop places
 * them among its icons whatever its sort (round 2).
 */
export function groupTarget(
  groupId: string,
  sort: GroupSort,
  body: HTMLElement | null,
  point: Point,
  reorder = false
): DropTarget {
  return {
    kind: 'group',
    groupId,
    ...resolveGroupDrop(body, point, sort, reorder),
    shown: body ? groupBodyIds(body) : []
  }
}

/** A drop on the desktop: the loose grid cell nearest the pointer. */
export function canvasTarget(point: Point, place: Pick<DropPlace, 'area' | 'cell'>): DropTarget {
  return { kind: 'canvas', anchor: cellAt(point, place.cell, place.area) }
}

/** True when every id is already in the group: a drag inside it (a reorder). */
export function reordersGroup(displayId: number, groupId: string, ids: readonly string[]): boolean {
  const group = useLayoutStore
    .getState()
    .layout.displays.find((entry) => entry.displayId === displayId)
    ?.groups.find((entry) => entry.id === groupId)
  return !!group && ids.length > 0 && ids.every((id) => group.items.includes(id))
}

export function hintOf(target: DropTarget): DropHint {
  return target.kind === 'group'
    ? { kind: 'group', groupId: target.groupId, index: target.index }
    : { kind: 'canvas', point: target.anchor }
}

/**
 * Puts `ids` (in the order they keep) at `target` on the display — one layout change:
 * - a drag inside one group reorders it at the anchor (a sorted group becomes `manual`, starting
 *   from the order shown; a drop in place changes nothing);
 * - a `manual` group inserts them before the anchor; other sorts append and re-sort;
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
    if (ids.every((id) => group.items.includes(id))) {
      // No insert point in a sorted group (not a reorder, e.g. an Explorer drop): it stays sorted.
      if (target.index === null && group.sort !== 'manual') return
      store.reorderInGroup(place.displayId, group.id, [...ids], target.beforeId, target.shown)
      return
    }
    const manual = group.sort === 'manual'
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
