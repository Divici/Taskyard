import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useLayoutEffect, useRef, useState } from 'react'
import type { Task } from '@shared/schema'
import { useTasksStore } from '../../../stores/tasks'
import { TASK_DRAG_KIND, TODO_SORTABLE_ID, type TaskDragData } from './task-drag'
import { moveId } from './task-lists'
import { TodoItem } from './TodoItem'

export interface TodoListProps {
  /** The active tasks, in display order (`splitTasks`). */
  tasks: Task[]
}

const store = (): ReturnType<typeof useTasksStore.getState> => useTasksStore.getState()

function SortableTodo({
  task,
  onMove
}: {
  task: Task
  onMove(delta: -1 | 1): void
}): React.JSX.Element {
  const data: TaskDragData = { kind: TASK_DRAG_KIND, taskId: task.id, text: task.text }
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: task.id,
    data
  })
  return (
    <TodoItem
      task={task}
      onToggle={() => store().toggle(task.id)}
      onEdit={(text) => store().edit(task.id, text)}
      onRemove={() => store().removeTask(task.id)}
      onMove={onMove}
      sortable={{
        setNodeRef,
        handleListeners: listeners,
        style: { transform: CSS.Translate.toString(transform), transition },
        dragging: isDragging
      }}
    />
  )
}

/**
 * The active tasks as a vertical sortable list: drag a row by its handle (routed by the canvas'
 * DndProvider, Phase 8's one DndContext) or press Alt+↑/↓ on a focused row. Every reorder saves
 * the new order of the active tasks (`reorderTasks`; completed tasks keep their place after).
 */
export function TodoList({ tasks }: TodoListProps): React.JSX.Element {
  const ids = tasks.map((task) => task.id)
  const list = useRef<HTMLUListElement>(null)
  const [announcement, setAnnouncement] = useState('')
  /** The row to focus once the list re-renders after a keyboard move. */
  const refocus = useRef<string | null>(null)

  useLayoutEffect(() => {
    const id = refocus.current
    if (id === null) return
    refocus.current = null
    const rows = list.current?.querySelectorAll<HTMLElement>('[data-task-id]') ?? []
    Array.from(rows)
      .find((row) => row.dataset.taskId === id)
      ?.focus()
  })

  const move = (task: Task, delta: -1 | 1): void => {
    const next = moveId(ids, task.id, delta)
    if (!next) return
    refocus.current = task.id
    store().reorderTasks(next)
    setAnnouncement(
      `Moved ${task.text} to position ${next.indexOf(task.id) + 1} of ${next.length}.`
    )
  }

  return (
    <>
      <SortableContext id={TODO_SORTABLE_ID} items={ids} strategy={verticalListSortingStrategy}>
        <ul ref={list} role="list" aria-label="Tasks" className="flex flex-col gap-0.5">
          {tasks.map((task) => (
            <SortableTodo key={task.id} task={task} onMove={(delta) => move(task, delta)} />
          ))}
        </ul>
      </SortableContext>
      <div role="status" className="sr-only">
        {announcement}
      </div>
    </>
  )
}
