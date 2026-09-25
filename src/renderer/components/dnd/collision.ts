import {
  closestCenter,
  pointerWithin,
  type Collision,
  type CollisionDetection
} from '@dnd-kit/core'
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
export const desktopCollision: CollisionDetection = (args) => {
  const { collisionRect } = args
  const pointerCoordinates = args.pointerCoordinates ?? {
    x: collisionRect.left + collisionRect.width / 2,
    y: collisionRect.top + collisionRect.height / 2
  }
  const hits = pointerWithin({ ...args, pointerCoordinates })
  if (hits.length > 0) return [...hits].sort((a, b) => rank(b) - rank(a))
  return closestCenter(args)
}
