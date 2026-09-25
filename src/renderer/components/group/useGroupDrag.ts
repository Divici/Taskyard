import { useRef, useState } from 'react'
import { moveRect } from '@shared/geometry'
import type { Rect } from '@shared/schema'

/** A press becomes a drag once the pointer has moved this far (px), so double-clicks work. */
export const DRAG_THRESHOLD = 3

export interface GroupDragOptions {
  /** The group's rect now (full height). */
  rect: Rect
  area: Rect
  snap: boolean
  /** Called once when the press turns into a drag. */
  onDragStart?(): void
  /** Every move while dragging (live preview). */
  onDrag(rect: Rect): void
  /** Released after a drag: the final rect. Not called for a plain click. */
  onDragEnd(rect: Rect): void
}

export interface GroupDrag {
  dragging: boolean
  /** Spread on the title bar. */
  handlers: {
    onPointerDown(event: React.PointerEvent<HTMLElement>): void
    onPointerMove(event: React.PointerEvent<HTMLElement>): void
    onPointerUp(event: React.PointerEvent<HTMLElement>): void
    onPointerCancel(event: React.PointerEvent<HTMLElement>): void
  }
}

interface Press {
  pointerId: number
  startX: number
  startY: number
  start: Rect
  last: Rect
  moved: boolean
}

/**
 * Title-bar drag for a group (and the tools widget): pointer capture, clamped into the work area,
 * snapped to 8 px when grid snap is on. `pointerdown` stops propagating so dnd-kit's sensor never
 * starts an item drag from the title bar; presses on buttons or the rename field are ignored.
 */
export function useGroupDrag({
  rect,
  area,
  snap,
  onDragStart,
  onDrag,
  onDragEnd
}: GroupDragOptions): GroupDrag {
  const press = useRef<Press | null>(null)
  const [dragging, setDragging] = useState(false)

  const finish = (event: React.PointerEvent<HTMLElement>, commit: boolean): void => {
    const current = press.current
    if (!current || current.pointerId !== event.pointerId) return
    press.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!current.moved) return
    setDragging(false)
    onDragEnd(commit ? current.last : current.start)
  }

  return {
    dragging,
    handlers: {
      onPointerDown(event) {
        if (event.button !== 0) return
        if ((event.target as Element).closest('button, input, [data-resize-edge]')) return
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        press.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          start: rect,
          last: rect,
          moved: false
        }
      },
      onPointerMove(event) {
        const current = press.current
        if (!current || current.pointerId !== event.pointerId) return
        const dx = event.clientX - current.startX
        const dy = event.clientY - current.startY
        if (!current.moved) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
          current.moved = true
          setDragging(true)
          onDragStart?.()
        }
        current.last = moveRect(current.start, dx, dy, area, snap)
        onDrag(current.last)
      },
      onPointerUp: (event) => finish(event, true),
      onPointerCancel: (event) => finish(event, false)
    }
  }
}
