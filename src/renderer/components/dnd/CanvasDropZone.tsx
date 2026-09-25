import { useDroppable } from '@dnd-kit/core'
import type { Size } from '@shared/geometry'
import { useUiStore } from '../../stores/ui'
import { CANVAS_DROP_ID, type CanvasDropData } from './dnd-types'

const CANVAS_DATA: CanvasDropData = { kind: 'canvas' }

/**
 * The desktop as a drop target: the whole window (groups above it win, see `desktopCollision`),
 * and the dashed grid cell where a drop on the desktop would land. Lets every pointer event
 * through to the canvas surface below.
 */
export function CanvasDropZone({ cell }: { cell: Size }): React.JSX.Element {
  const { setNodeRef } = useDroppable({ id: CANVAS_DROP_ID, data: CANVAS_DATA })
  const hint = useUiStore((state) => (state.dropHint?.kind === 'canvas' ? state.dropHint : null))

  return (
    <div ref={setNodeRef} data-canvas-drop="" className="pointer-events-none absolute inset-0">
      {hint && (
        <div
          data-drop-cell=""
          aria-hidden="true"
          className="absolute rounded-[10px] border-2 border-dashed border-accent-1/70 bg-accent-2/15 transition-[left,top] duration-100"
          style={{
            left: hint.point.x,
            top: hint.point.y,
            width: cell.width,
            height: cell.height
          }}
        />
      )}
    </div>
  )
}
