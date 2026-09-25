import { useRef } from 'react'
import { resizeRect, type ResizeEdge, type Size } from '@shared/geometry'
import type { Rect } from '@shared/schema'
import { cn } from '../../lib/utils'

export interface ResizeHandlesProps {
  /** The rect the group has now (its full height, even when rolled up). */
  rect: Rect
  /** The work area the group must stay inside (window coordinates). */
  area: Rect
  min: Size
  snap: boolean
  /** Rolled up: only the side handles (the width can change, the height is kept). */
  rolledUp: boolean
  onResizeStart?(): void
  /** Every pointer move while resizing (live preview). */
  onResize(rect: Rect): void
  /** Pointer released: the final rect (unchanged when the pointer did not move). */
  onResizeEnd(rect: Rect): void
}

const ALL_EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const SIDE_EDGES: readonly ResizeEdge[] = ['e', 'w']

/**
 * Where each handle sits and its cursor: edges are 6 px strips, corners 12 px squares, all inside
 * the group's box (`.glass` has `contain: paint`, which clips anything outside it, hit testing
 * included).
 */
const EDGE_CLASS: Readonly<Record<ResizeEdge, string>> = {
  n: 'top-0 left-3 right-3 h-1.5 cursor-ns-resize',
  s: 'bottom-0 left-3 right-3 h-1.5 cursor-ns-resize',
  e: 'right-0 top-3 bottom-3 w-1.5 cursor-ew-resize',
  w: 'left-0 top-3 bottom-3 w-1.5 cursor-ew-resize',
  ne: 'top-0 right-0 size-3 cursor-nesw-resize',
  nw: 'top-0 left-0 size-3 cursor-nwse-resize',
  se: 'bottom-0 right-0 size-3 cursor-nwse-resize',
  sw: 'bottom-0 left-0 size-3 cursor-nesw-resize'
}

interface Drag {
  pointerId: number
  startX: number
  startY: number
  start: Rect
  last: Rect
}

function Handle({ edge, ...props }: ResizeHandlesProps & { edge: ResizeEdge }): React.JSX.Element {
  const drag = useRef<Drag | null>(null)

  return (
    <div
      aria-hidden="true"
      data-resize-edge={edge}
      className={cn('absolute z-10 touch-none', EDGE_CLASS[edge])}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        // Never reaches the drag-and-drop sensor or the title-bar drag (Decision 8).
        event.stopPropagation()
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          start: props.rect,
          last: props.rect
        }
        props.onResizeStart?.()
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current || current.pointerId !== event.pointerId) return
        current.last = resizeRect(
          current.start,
          edge,
          event.clientX - current.startX,
          event.clientY - current.startY,
          { min: props.min, area: props.area, snap: props.snap }
        )
        props.onResize(current.last)
      }}
      onPointerUp={(event) => {
        const current = drag.current
        if (!current || current.pointerId !== event.pointerId) return
        drag.current = null
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        props.onResizeEnd(current.last)
      }}
      onPointerCancel={() => {
        const current = drag.current
        drag.current = null
        if (current) props.onResizeEnd(current.start)
      }}
    />
  )
}

/**
 * The 8 resize handles of a group (or the tools widget): pointer-captured drags that resize
 * live, stop at the minimum size, stay inside the work area and snap to 8 px when grid snap is
 * on. `pointerdown` stops propagating, so dnd-kit's sensor never sees a resize.
 */
export function ResizeHandles(props: ResizeHandlesProps): React.JSX.Element {
  const edges = props.rolledUp ? SIDE_EDGES : ALL_EDGES
  return (
    <>
      {edges.map((edge) => (
        <Handle key={edge} edge={edge} {...props} />
      ))}
    </>
  )
}
