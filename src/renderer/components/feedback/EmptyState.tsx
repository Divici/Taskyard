import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface EmptyStateProps {
  title: string
  hint?: string
  /** A decorative icon above the title. */
  icon?: LucideIcon
  className?: string
}

/**
 * What an empty surface says instead of nothing: an empty group ("Drop icons here"), an empty
 * to-do list. A polite status, so it is announced when a list empties, not on every render.
 */
export function EmptyState({
  title,
  hint,
  icon: Icon,
  className
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center gap-1 p-3 text-center text-text-tertiary',
        className
      )}
    >
      {Icon && <Icon aria-hidden="true" className="mb-1 size-5 opacity-70" />}
      <p className="text-[12px] text-text-secondary">{title}</p>
      {hint && <p className="text-[11px]">{hint}</p>}
    </div>
  )
}
