import { useMemo } from 'react'
import { getBridge } from '../../lib/bridge'
import { useLayoutStore } from '../../stores/layout'
import { useUiStore } from '../../stores/ui'
import { canvasTarget, groupTarget, hintOf, type DropPlace, type DropTarget } from './drop-actions'
import { dropExternalFiles } from './external-drop'

export interface ExternalDropHandlers {
  onDragEnter(event: React.DragEvent<HTMLElement>): void
  onDragOver(event: React.DragEvent<HTMLElement>): void
  onDragLeave(event: React.DragEvent<HTMLElement>): void
  onDrop(event: React.DragEvent<HTMLElement>): void
}

const carriesFiles = (event: React.DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files')

/**
 * Native file drops from Explorer (Phase 8; LOCKED Decision 8: native `drop` +
 * `webUtils.getPathForFile`, apart from dnd-kit's pointer drags). Spread on the canvas root: the
 * browser's own hit test picks the element under the pointer, so a drop on a group (the topmost
 * one, as painted) goes into it at the index under the pointer, and anything else lands on the
 * desktop grid. The drop hint follows `dragover`.
 */
export function createExternalDrop(place: DropPlace): ExternalDropHandlers {
  const { displayId } = place
  // dragenter/dragleave fire for every child crossed; the hint clears when the count hits 0.
  let depth = 0

  const targetOf = (event: React.DragEvent): DropTarget => {
    const point = { x: event.clientX, y: event.clientY }
    const section =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-group-id]') : null
    const groupId = section?.dataset.groupId
    const group = useLayoutStore
      .getState()
      .layout.displays.find((entry) => entry.displayId === displayId)
      ?.groups.find((entry) => entry.id === groupId)
    if (section && group) {
      const body = section.querySelector<HTMLElement>('[data-group-body]')
      return groupTarget(group.id, group.sort, body, point)
    }
    return canvasTarget(point, place)
  }

  return {
    onDragEnter(event) {
      if (!carriesFiles(event)) return
      event.preventDefault()
      depth += 1
    },
    onDragOver(event) {
      if (!carriesFiles(event)) return
      // Accepting the drag: Explorer shows "Move" (the files move into the Desktop folder).
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      useUiStore.getState().setDropHint(hintOf(targetOf(event)))
    },
    onDragLeave(event) {
      if (!carriesFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) useUiStore.getState().setDropHint(null)
    },
    onDrop(event) {
      if (!carriesFiles(event)) return
      event.preventDefault()
      depth = 0
      useUiStore.getState().setDropHint(null)
      const target = targetOf(event)
      const api = getBridge()
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => api.desktop.pathForFile(file))
        .filter((path) => path !== '')
      void dropExternalFiles(paths, target, place)
    }
  }
}

/** `createExternalDrop` for this display, rebuilt only when the display's geometry changes. */
export function useExternalDrop({ displayId, area, cell }: DropPlace): ExternalDropHandlers {
  const { x, y, width, height } = area
  const { width: cellWidth, height: cellHeight } = cell
  return useMemo(
    () =>
      createExternalDrop({
        displayId,
        area: { x, y, width, height },
        cell: { width: cellWidth, height: cellHeight }
      }),
    [displayId, x, y, width, height, cellWidth, cellHeight]
  )
}
