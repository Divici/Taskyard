import type { Active, Announcements, Over } from '@dnd-kit/core'
import { isTaskDrag, onTaskDragEnd, type TaskDragData } from '../tools/todo/task-drag'
import type { ItemDropHandlers } from './useItemDrop'

// Phase 10: one DndContext per canvas carries two kinds of drags — desktop icons (Phase 8) and
// to-do rows (sortable). Each dnd-kit event goes to the handlers of the kind being dragged.

/** The to-do list's handlers: rows move themselves while dragged; the drop saves the order. */
const TASK_HANDLERS: Partial<ItemDropHandlers> = { onDragEnd: onTaskDragEnd }

const taskText = (active: Active): string =>
  (active.data.current as TaskDragData | undefined)?.text ?? 'the task'

/** 1-based position of a to-do row droppable, when it is one. */
function position(over: Over | null): string | null {
  const sortable = (over?.data.current as { sortable?: { index: number; items: unknown[] } })
    ?.sortable
  return sortable ? `position ${sortable.index + 1} of ${sortable.items.length}` : null
}

/** The live-region lines: `icons` for desktop icons, task wording for to-do rows. */
export function routeAnnouncements(icons: Announcements): Announcements {
  return {
    onDragStart: (event) =>
      isTaskDrag(event.active)
        ? `Picked up task ${taskText(event.active)}.`
        : icons.onDragStart(event),
    onDragOver: (event) => {
      if (!isTaskDrag(event.active)) return icons.onDragOver(event)
      const at = position(event.over)
      return at ? `Task ${taskText(event.active)} is over ${at}.` : undefined
    },
    onDragEnd: (event) => {
      if (!isTaskDrag(event.active)) return icons.onDragEnd(event)
      const at = position(event.over)
      return at
        ? `Dropped task ${taskText(event.active)} at ${at}.`
        : `Task ${taskText(event.active)} was not moved.`
    },
    onDragCancel: (event) =>
      isTaskDrag(event.active)
        ? `Moving task ${taskText(event.active)} was cancelled.`
        : icons.onDragCancel(event)
  }
}

/** `item` for desktop icons, the to-do handlers for rows (by `active.data.current.kind`). */
export function routeDragEvents(item: ItemDropHandlers): ItemDropHandlers {
  const pick = ({ active }: { active: Active }): Partial<ItemDropHandlers> =>
    isTaskDrag(active) ? TASK_HANDLERS : item
  return {
    onDragStart: (event) => pick(event).onDragStart?.(event),
    onDragMove: (event) => pick(event).onDragMove?.(event),
    onDragOver: (event) => pick(event).onDragOver?.(event),
    onDragEnd: (event) => pick(event).onDragEnd?.(event),
    onDragCancel: (event) => pick(event).onDragCancel?.(event)
  }
}
