import { useId } from 'react'
import type { Task } from '@shared/schema'
import { cn } from '../../lib/utils'
import { FIELD } from './tool-styles'

// A counting tool's link to a task (the Timer's and, since round 2, the Stopwatch's): the
// "Focus on…" picker and the one-line "Focus: <task>" under the ring.

export interface TaskPickerProps {
  /** The active tasks, in list order. */
  active: readonly Task[]
  /** The linked task, if any (a done one shows as "No task": it cannot be picked again). */
  linked: Task | undefined
  onLink(taskId: string | null): void
}

/** "Focus on…": links one of the active tasks, or none. */
export function TaskPicker({ active, linked, onLink }: TaskPickerProps): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex w-full items-center gap-2 text-[11px] text-text-secondary">
      <label htmlFor={id} className="w-16 shrink-0">
        Focus on…
      </label>
      <select
        id={id}
        value={linked && !linked.done ? linked.id : ''}
        onChange={(event) => onLink(event.target.value || null)}
        className={cn(FIELD, 'min-w-0 flex-1 [&>option]:bg-[#0b1220] [&>option]:text-white')}
      >
        <option value="">No task</option>
        {active.map((task) => (
          <option key={task.id} value={task.id}>
            {task.text}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Round 2: "Focus: <task>" as a single line under the ring, cut short with an ellipsis; the full
 * text is its tooltip. It keeps its height when empty, so linking a task never shifts the layout.
 */
export function FocusLine({ task }: { task: Task | undefined }): React.JSX.Element {
  const text = task ? `Focus: ${task.text}` : ''
  return (
    <p
      title={text || undefined}
      className={cn(
        'h-4 w-full max-w-[240px] shrink-0 truncate text-center text-[12px] leading-4 text-text-secondary',
        task?.done && 'line-through opacity-70'
      )}
    >
      {text}
    </p>
  )
}
