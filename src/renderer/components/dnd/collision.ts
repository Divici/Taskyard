import {
  closestCenter,
  pointerWithin,
  type Collision,
  type CollisionDetection
} from '@dnd-kit/core'
import { isTaskDrag, TASK_DRAG_KIND } from '../tools/todo/task-drag'
import type { DropData } from './dnd-types'

/** Groups stack above the desktop (the canvas drop zone covers the whole window). */
function rank(collision: Collision): number {
  const data = collision.data?.droppableContainer?.data?.current as DropData | undefined
  return data?.kind === 'group' ? data.z + 1 : 0
}

/**
 * Which droppable a drag is over: the ones under the pointer (`pointerWithin`; a keyboard drag
 * uses the centre of the dragged icon), topmost group first, like the pixels the user sees;
 * `closestCenter` when the pointer is over none of them.
 */
export const desktopCollision: CollisionDetection = (input) => {
  // Phase 10: a to-do row only ever lands on another row (closest centre, the sortable list's
  // usual rule); a desktop icon never lands on a row.
  const task = isTaskDrag(input.active)
  const droppableContainers = input.droppableContainers.filter(
    (container) => (container.data.current?.['kind'] === TASK_DRAG_KIND) === task
  )
  const args = { ...input, droppableContainers }
  if (task) return closestCenter(args)
  const { collisionRect } = args
  const pointerCoordinates = args.pointerCoordinates ?? {
    x: collisionRect.left + collisionRect.width / 2,
    y: collisionRect.top + collisionRect.height / 2
  }
  const hits = pointerWithin({ ...args, pointerCoordinates })
  if (hits.length > 0) return [...hits].sort((a, b) => rank(b) - rank(a))
  return closestCenter(args)
}
