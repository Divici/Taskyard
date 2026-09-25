import type {
  Active,
  DragCancelEvent,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
  Over,
  Translate
} from '@dnd-kit/core'
import { useMemo } from 'react'
import type { Point } from '@shared/schema'
import { useItemsStore } from '../../stores/items'
import { useLayoutStore } from '../../stores/layout'
import { useUiStore } from '../../stores/ui'
import type { DropData } from './dnd-types'
import { dragOrder } from './drag-order'
import {
  canvasTarget,
  dropItems,
  groupTarget,
  hintOf,
  type DropPlace,
  type DropTarget
} from './drop-actions'

export interface ItemDropHandlers {
  onDragStart(event: DragStartEvent): void
  onDragMove(event: DragMoveEvent): void
  onDragOver(event: DragOverEvent): void
  onDragEnd(event: DragEndEvent): void
  onDragCancel(event: DragCancelEvent): void
}

/** What every dnd-kit drag event carries that the drop needs. */
interface Moving {
  active: Active
  activatorEvent: Event | null
  delta: Translate
  over: Over | null
}

/**
 * The pointer now: where the press was plus how far it moved. A keyboard drag has no pointer:
 * the centre of the dragged icon stands in.
 */
function dragPoint({ activatorEvent, delta, active }: Moving): Point | null {
  if (activatorEvent instanceof MouseEvent) {
    return { x: activatorEvent.clientX + delta.x, y: activatorEvent.clientY + delta.y }
  }
  const rect = active.rect.current.translated
  return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
}

function targetOf(event: Moving, place: DropPlace): DropTarget | null {
  const point = dragPoint(event)
  const data = event.over?.data.current as DropData | undefined
  if (!point || !data) return null
  return data.kind === 'group'
    ? groupTarget(data.groupId, data.sort, data.body(), point)
    : canvasTarget(point, place)
}

/** dnd-kit's handlers for dragging desktop icons on one display (Phase 8). */
export function createItemDrop(place: DropPlace): ItemDropHandlers {
  const track = (event: Moving): void => {
    const target = targetOf(event, place)
    useUiStore.getState().setDropHint(target ? hintOf(target) : null)
  }

  return {
    onDragStart(event) {
      const id = String(event.active.id)
      const ui = useUiStore.getState()
      const display = useLayoutStore
        .getState()
        .layout.displays.find((entry) => entry.displayId === place.displayId)
      // A multi-selection moves together when the grabbed icon is in it; otherwise the grabbed
      // icon alone moves and becomes the selection (Explorer).
      const multi = ui.selection.includes(id)
      if (!multi) ui.select([id])
      const ids =
        multi && display ? dragOrder(ui.selection, display, useItemsStore.getState().byId) : [id]
      ui.setDrag({
        ids,
        activeId: id,
        sourceGroups: (display?.groups ?? [])
          .filter((group) => group.items.some((item) => ids.includes(item)))
          .map((group) => group.id),
        pointer: event.activatorEvent instanceof MouseEvent
      })
    },
    onDragMove: track,
    onDragOver: track,
    onDragEnd(event) {
      const ui = useUiStore.getState()
      const drag = ui.drag
      const target = targetOf(event, place)
      ui.endDrag()
      if (drag && target) dropItems(place, drag.ids, drag.activeId, target)
    },
    onDragCancel() {
      useUiStore.getState().endDrag()
    }
  }
}

/** `createItemDrop` for this display, rebuilt only when the display's geometry changes. */
export function useItemDrop({ displayId, area, cell }: DropPlace): ItemDropHandlers {
  const { x, y, width, height } = area
  const { width: cellWidth, height: cellHeight } = cell
  return useMemo(
    () =>
      createItemDrop({
        displayId,
        area: { x, y, width, height },
        cell: { width: cellWidth, height: cellHeight }
      }),
    [displayId, x, y, width, height, cellWidth, cellHeight]
  )
}
