import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities'
import { Check, GripVertical, X } from 'lucide-react'
import { useId, useState } from 'react'
import type { Task } from '@shared/schema'
import { cn } from '../../../lib/utils'
import { TASK_TEXT_MAX } from '../../../stores/tasks'
import { RenameInline } from '../../icon/RenameInline'

/** What a sortable row hands its item (useSortable): the handle's listeners and the row box. */
export interface SortableBinding {
  setNodeRef(node: HTMLElement | null): void
  /** Spread on the drag handle only (the rest of the row stays clickable). */
  handleListeners: SyntheticListenerMap | undefined
  style: React.CSSProperties
  dragging: boolean
}

export interface TodoItemProps {
  task: Task
  onToggle(): void
  onEdit(text: string): void
  onRemove(): void
  /** Alt+↑ / Alt+↓ (active tasks only). */
  onMove?(delta: -1 | 1): void
  sortable?: SortableBinding
}

const ROW_ICON_BUTTON =
  'flex size-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-[opacity,background-color,color] hover:bg-white/10 hover:text-text-primary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:outline-none [[data-theme=light]_&]:hover:bg-black/5'

/**
 * One to-do: a round checkbox, the text (double-click or F2 edits it inline), a delete × and,
 * for active tasks, a drag handle. The row itself is focusable: Space toggles, F2 or Enter edits,
 * Delete removes, Alt+↑/↓ moves it.
 */
export function TodoItem({
  task,
  onToggle,
  onEdit,
  onRemove,
  onMove,
  sortable
}: TodoItemProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const textId = useId()

  const onKeyDown = (event: React.KeyboardEvent<HTMLLIElement>): void => {
    if (editing) return
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      if (!onMove) return
      event.preventDefault()
      event.stopPropagation()
      onMove(event.key === 'ArrowUp' ? -1 : 1)
      return
    }
    if (event.key === 'F2') {
      event.preventDefault()
      setEditing(true)
      return
    }
    // The rest act on the row itself (its buttons handle their own Space and Enter).
    if (event.target !== event.currentTarget) return
    if (event.key === ' ') {
      event.preventDefault()
      onToggle()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      setEditing(true)
    } else if (event.key === 'Delete') {
      event.preventDefault()
      onRemove()
    }
  }

  return (
    <li
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      tabIndex={0}
      aria-label={task.text}
      data-task-id={task.id}
      data-dragging={sortable?.dragging || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        'group/todo relative flex min-h-9 items-center gap-1.5 rounded-[10px] py-1 pr-1 pl-1 outline-none',
        'hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-accent-1/70 [[data-theme=light]_&]:hover:bg-black/[0.04]',
        sortable?.dragging &&
          'z-10 bg-white/10 shadow-[var(--glow)] [[data-theme=light]_&]:bg-white/70'
      )}
    >
      {sortable ? (
        <span
          aria-hidden="true"
          data-drag-handle=""
          {...sortable.handleListeners}
          className="flex h-6 w-3.5 shrink-0 cursor-grab touch-none items-center justify-center text-text-tertiary opacity-0 transition-opacity group-hover/todo:opacity-100 group-focus-visible/todo:opacity-100 active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </span>
      ) : (
        <span aria-hidden="true" className="w-3.5 shrink-0" />
      )}
      <button
        type="button"
        role="checkbox"
        aria-checked={task.done}
        aria-labelledby={textId}
        onClick={onToggle}
        className={cn(
          'flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] transition-[background-color,border-color,box-shadow] duration-[180ms]',
          'focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent focus-visible:outline-none',
          task.done
            ? 'border-accent-1 bg-accent-1 text-[#001233] shadow-[0_0_8px_color-mix(in_srgb,var(--accent-1)_60%,transparent)] [[data-theme=light]_&]:text-white'
            : 'border-text-tertiary hover:border-accent-1'
        )}
      >
        {task.done && <Check aria-hidden="true" strokeWidth={3} className="size-3" />}
      </button>
      {editing ? (
        <RenameInline
          value={task.text}
          label={`Edit task ${task.text}`}
          blockInvalidChars={false}
          maxLength={TASK_TEXT_MAX}
          onCommit={(text) => {
            setEditing(false)
            onEdit(text)
          }}
          onCancel={() => setEditing(false)}
          className="min-w-0 flex-1 [&_input]:py-1 [&_input]:text-left [&_input]:text-[13px]"
        />
      ) : (
        <span
          id={textId}
          onDoubleClick={() => setEditing(true)}
          className={cn(
            'min-w-0 flex-1 cursor-text px-1 text-[13px] leading-snug break-words',
            task.done ? 'text-text-tertiary line-through' : 'text-text-primary'
          )}
        >
          {task.text}
        </span>
      )}
      <button
        type="button"
        aria-label={`Delete ${task.text}`}
        onClick={onRemove}
        className={cn(
          ROW_ICON_BUTTON,
          'opacity-0 group-focus-within/todo:opacity-100 group-hover/todo:opacity-100'
        )}
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </li>
  )
}
