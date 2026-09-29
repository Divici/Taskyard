import { Plus } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '../../../lib/utils'
import { TASK_TEXT_MAX } from '../../../stores/tasks'

export interface TodoInputProps {
  /** Adds the task; returns false when nothing was added (blank text). */
  onAdd(text: string): boolean
}

/**
 * The "Add a task…" row (round 2): one obvious field with a real Add button — the round + at its
 * end, disabled while the text is blank. Enter or the button adds; the field clears and keeps
 * focus so the next task can be typed straight away. A press anywhere on the row (the disabled
 * button included) puts the caret in the field. At most 500 characters.
 */
export function TodoInput({ onAdd }: TodoInputProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const blank = draft.trim() === ''

  const submit = (): void => {
    if (onAdd(draft)) setDraft('')
    field.current?.focus()
  }

  return (
    <div
      data-add-row=""
      // Presses on the row (padding, the button) keep the caret in the field instead of moving
      // focus; the field itself handles its own presses (caret placement, selection).
      onMouseDown={(event) => {
        if (event.target === field.current) return
        event.preventDefault()
        field.current?.focus()
      }}
      onClick={() => field.current?.focus()}
      className={cn(
        'flex cursor-text items-center gap-2 rounded-[12px] border py-1 pr-1 pl-3',
        'border-white/10 bg-black/25 focus-within:border-accent-1/60 focus-within:ring-2 focus-within:ring-accent-1/30',
        '[[data-theme=light]_&]:border-black/10 [[data-theme=light]_&]:bg-white/55'
      )}
    >
      <input
        ref={field}
        type="text"
        aria-label="Add a task"
        placeholder="Add a task…"
        value={draft}
        maxLength={TASK_TEXT_MAX}
        spellCheck
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          submit()
        }}
        className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
      />
      <button
        type="button"
        aria-label="Add task"
        title="Add task (Enter)"
        disabled={blank}
        onClick={(event) => {
          event.stopPropagation()
          submit()
        }}
        className={cn(
          'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full transition-[background-color,box-shadow,opacity] duration-[180ms]',
          'focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:outline-none',
          // Disabled, presses fall through to the row (which focuses the field).
          'disabled:pointer-events-none disabled:bg-white/8 disabled:text-text-tertiary [[data-theme=light]_&]:disabled:bg-black/5',
          'bg-accent-2 text-white shadow-[0_0_12px_color-mix(in_srgb,var(--accent-2)_55%,transparent)] hover:brightness-110',
          '[[data-theme=light]_&]:bg-accent-1 [[data-theme=light]_&]:shadow-[0_0_10px_color-mix(in_srgb,var(--accent-1)_40%,transparent)]'
        )}
      >
        <Plus aria-hidden="true" className="size-4" />
      </button>
    </div>
  )
}
