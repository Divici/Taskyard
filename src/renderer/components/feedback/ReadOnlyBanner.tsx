import { TriangleAlert } from 'lucide-react'
import { readOnlySentences } from '../../lib/storage-messages'
import { useUiStore } from '../../stores/ui'

/**
 * Persistent notice while any data file is read-only (written by a newer Taskyard, or unreadable).
 * It has no dismiss: every change made meanwhile is silently not saved, so it must stay visible.
 */
export function ReadOnlyBanner(): React.JSX.Element | null {
  const readOnly = useUiStore((state) => state.readOnly)
  if (readOnly.length === 0) return null

  return (
    <div
      role="alert"
      data-peek-keep=""
      className="fixed inset-x-0 top-0 z-50 flex items-start gap-3 border-b border-amber-500/50 bg-amber-50 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p>
        <strong className="font-semibold">Read-only mode.</strong>{' '}
        {readOnlySentences(readOnly).join(' ')}
      </p>
    </div>
  )
}
