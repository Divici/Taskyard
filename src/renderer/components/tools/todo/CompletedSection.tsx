import { ChevronRight } from 'lucide-react'
import { useId, useState } from 'react'
import type { Task } from '@shared/schema'
import { cn } from '../../../lib/utils'
import { useTasksStore } from '../../../stores/tasks'
import { TodoItem } from './TodoItem'

export interface CompletedSectionProps {
  /** The completed tasks, newest first (`splitTasks`). */
  tasks: Task[]
}

const store = (): ReturnType<typeof useTasksStore.getState> => useTasksStore.getState()

/**
 * The done tasks, struck through, under a collapsed "Completed (n)" toggle, with "Clear
 * completed". Unchecking one sends it back to the bottom of the active list. Hidden when empty.
 */
export function CompletedSection({ tasks }: CompletedSectionProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const listId = useId()
  if (tasks.length === 0) return null

  return (
    <section
      aria-label="Completed"
      className="mt-2 border-t border-white/5 pt-2 [[data-theme=light]_&]:border-black/5"
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => setOpen((value) => !value)}
          className="flex items-center gap-1 rounded-md px-1 py-1 text-[11px] font-semibold tracking-[0.08em] text-text-secondary uppercase transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:outline-none"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn('size-3.5 transition-transform duration-[180ms]', open && 'rotate-90')}
          />
          Completed ({tasks.length})
        </button>
        <button
          type="button"
          onClick={() => store().clearCompleted()}
          className="rounded-md px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-white/10 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:outline-none [[data-theme=light]_&]:hover:bg-black/5"
        >
          Clear completed
        </button>
      </div>
      {open && (
        <ul
          id={listId}
          role="list"
          aria-label="Completed tasks"
          className="mt-1 flex flex-col gap-0.5"
        >
          {tasks.map((task) => (
            <TodoItem
              key={task.id}
              task={task}
              onToggle={() => store().toggle(task.id)}
              onEdit={(text) => store().edit(task.id, text)}
              onRemove={() => store().removeTask(task.id)}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
