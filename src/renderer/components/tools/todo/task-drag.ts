import type { Active, DragEndEvent, Over } from '@dnd-kit/core'
import { useTasksStore } from '../../../stores/tasks'
import { moveIndex } from './task-lists'

// Phase 10: to-do rows are sortables in the canvas' one DndContext (Phase 8's DndProvider, which
// routes a drag by `active.data.current.kind`). Their data says what they are.

export const TASK_DRAG_KIND = 'task'
/** The to-do list's SortableContext id. */
export const TODO_SORTABLE_ID = 'todo-list'

/** Carried by every to-do row's sortable. */
export interface TaskDragData {
  kind: typeof TASK_DRAG_KIND
  taskId: string
  /** For the drag announcements. */
  text: string
}

/** What dnd-kit's sortable adds to a sortable's data. */
interface SortableInfo {
  sortable?: { containerId: string; index: number; items: Array<string | number> }
}

type Data = Partial<TaskDragData> & SortableInfo

const dataOf = (node: Active | Over | null): Data | undefined =>
  node?.data.current as Data | undefined

/** A drag (or a droppable) that is a to-do row. */
export function isTaskDrag(node: Active | Over | null): boolean {
  return dataOf(node)?.kind === TASK_DRAG_KIND
}

/**
 * The active ids in their new order when a row is dropped on another row of the same list;
 * null when nothing moves.
 */
export function droppedOrder(active: Active, over: Over | null): string[] | null {
  const from = dataOf(active)?.sortable
  const to = dataOf(over)?.sortable
  if (!from || !to || from.containerId !== to.containerId || from.index === to.index) return null
  return moveIndex(from.items.map(String), from.index, to.index)
}

/** dnd-kit's drop handler for to-do rows: saves the new order. */
export function onTaskDragEnd({ active, over }: DragEndEvent): void {
  const order = droppedOrder(active, over)
  if (order) useTasksStore.getState().reorderTasks(order)
}
