import { Plus } from 'lucide-react'
import { useState } from 'react'
import { TASK_TEXT_MAX } from '../../../stores/tasks'

export interface TodoInputProps {
  /** Adds the task; returns false when nothing was added (blank text). */
  onAdd(text: string): boolean
}

/**
 * The single-line "Add a task" field: Enter adds (blank text is ignored), the field clears and
 * keeps focus so the next task can be typed straight away. At most 500 characters.
 */
export function TodoInput({ onAdd }: TodoInputProps): React.JSX.Element {
  const [draft, setDraft] = useState('')

  return (
    <div className="flex items-center gap-2 rounded-[12px] border border-white/10 bg-black/25 px-3 focus-within:border-accent-1/60 focus-within:ring-2 focus-within:ring-accent-1/30 [[data-theme=light]_&]:border-black/10 [[data-theme=light]_&]:bg-white/55">
      <Plus aria-hidden="true" className="size-3.5 shrink-0 text-text-tertiary" />
      <input
        type="text"
        aria-label="Add a task"
        placeholder="Add a task"
        value={draft}
        maxLength={TASK_TEXT_MAX}
        spellCheck
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          if (onAdd(draft)) setDraft('')
        }}
        className="h-9 min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
      />
    </div>
  )
}
