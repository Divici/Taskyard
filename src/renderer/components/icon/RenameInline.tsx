import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '../../lib/utils'

/** Characters Windows never allows in a file name. */
const INVALID_CHARS = /[<>:"/\\|?*]/g

export const INVALID_NAME_HINT =
  'A file name can’t contain any of these characters: \\ / : * ? " < > |'

/** Windows' limit for one file name (the part after the last backslash). */
export const MAX_NAME_LENGTH = 255

export interface RenameInlineProps {
  value: string
  /** Accessible name of the field, e.g. "Rename notes". */
  label: string
  /** The new name, trimmed; only called when it is non-empty and changed. */
  onCommit(next: string): void
  /** Esc, or an empty or unchanged name. */
  onCancel(): void
  /** Read-only items (Public Desktop for a standard user): the field is disabled. */
  readOnly?: boolean
  /** File names block `<>:"/\|?*`; group titles do not. */
  blockInvalidChars?: boolean
  maxLength?: number
  className?: string
  /**
   * Phase 9: why the last rename failed (e.g. the name exists). Shown under the field until the
   * name changes; Enter on the same name keeps the field open, leaving it cancels.
   */
  error?: string
  /** The field's starting text (the name that failed); `value` when omitted. */
  initialDraft?: string
}

/**
 * Explorer-style inline rename: opens focused with the name selected; Enter or leaving the field
 * commits, Esc cancels, an empty or unchanged name reverts. Keys never reach the list around it
 * (arrows, Delete, F2 belong to the field while it is open).
 */
export function RenameInline({
  value,
  label,
  onCommit,
  onCancel,
  readOnly = false,
  blockInvalidChars = true,
  maxLength = MAX_NAME_LENGTH,
  className,
  error,
  initialDraft
}: RenameInlineProps): React.JSX.Element {
  const start = initialDraft ?? value
  const [draft, setDraft] = useState(start)
  const [blocked, setBlocked] = useState(false)
  const [showError, setShowError] = useState(error !== undefined)
  const errorId = useId()
  const input = useRef<HTMLInputElement>(null)
  // Enter, Esc and blur can all fire for one edit (Enter commits, then the field unmounts and
  // blurs); only the first one counts.
  const done = useRef(false)

  useEffect(() => {
    const field = input.current
    if (!field || readOnly) return
    field.focus()
    field.select()
  }, [readOnly])

  const finish = (commit: boolean, via: 'key' | 'blur' = 'key'): void => {
    if (done.current || readOnly) return
    const next = draft.trim()
    // The name that just failed: Enter shows why again (the field stays), leaving it gives up.
    if (commit && error !== undefined && next === start.trim()) {
      if (via === 'key') {
        setShowError(true)
        return
      }
      commit = false
    }
    done.current = true
    if (commit && next !== '' && next !== value) onCommit(next)
    else onCancel()
  }

  return (
    <span className={cn('relative block w-full', className)}>
      <input
        ref={input}
        aria-label={label}
        value={draft}
        disabled={readOnly}
        aria-invalid={showError || undefined}
        aria-describedby={showError ? errorId : undefined}
        maxLength={maxLength}
        spellCheck={false}
        onChange={(event) => {
          const raw = event.target.value
          const clean = blockInvalidChars ? raw.replace(INVALID_CHARS, '') : raw
          if (clean !== raw) setBlocked(true)
          setShowError(false)
          setDraft(clean.slice(0, maxLength))
        }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            finish(true)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            finish(false)
          }
        }}
        onBlur={() => finish(true, 'blur')}
        // Clicks inside the field must not select, drag or open the item under it.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        className="w-full rounded-[6px] border border-accent-1/60 bg-black/60 px-1 py-0.5 text-center text-[11px] text-white outline-none focus:ring-2 focus:ring-accent-1/60 disabled:opacity-60 [[data-theme=light]_&]:bg-white/90 [[data-theme=light]_&]:text-text-primary"
      />
      {showError && error !== undefined && (
        <span
          id={errorId}
          role="alert"
          className="glass absolute top-full left-1/2 z-10 mt-1 w-56 -translate-x-1/2 border-red-400/70 px-3 py-2 text-left text-[11px] leading-snug"
        >
          {error}
        </span>
      )}
      {blocked && !showError && (
        <span
          role="status"
          className="glass absolute top-full left-1/2 z-10 mt-1 w-56 -translate-x-1/2 px-3 py-2 text-left text-[11px] leading-snug"
        >
          {INVALID_NAME_HINT}
        </span>
      )}
    </span>
  )
}
