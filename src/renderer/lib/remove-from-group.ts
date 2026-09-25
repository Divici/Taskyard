import { cellAt, looseDropPositions } from '@shared/drop-placement'
import type { Size } from '@shared/geometry'
import type { Rect } from '@shared/schema'
import { useLayoutStore } from '../stores/layout'

/**
 * "Remove from group" (Phase 9): the items of `groupId` among `ids` become loose icons in free
 * grid cells next to the group — column-first from its top-right corner, never on a group or
 * another icon — in one layout change. Ids that are not in the group are left where they are.
 */
export function removeFromGroup(
  displayId: number,
  groupId: string,
  ids: readonly string[],
  area: Rect,
  cell: Size
): void {
  const store = useLayoutStore.getState()
  const display = store.layout.displays.find((entry) => entry.displayId === displayId)
  const group = display?.groups.find((entry) => entry.id === groupId)
  if (!display || !group) return
  const leaving = ids.filter((id) => group.items.includes(id))
  if (leaving.length === 0) return
  const anchor = cellAt(
    { x: group.x + group.w + cell.width / 2, y: group.y + cell.height / 2 },
    cell,
    area
  )
  const positions = looseDropPositions({
    ids: leaving,
    activeId: leaving[0],
    anchor,
    display,
    cell,
    area
  })
  store.placeItems(displayId, leaving, { loose: positions })
}
