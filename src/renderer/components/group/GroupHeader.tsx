import { ChevronDown, ChevronUp, MoreHorizontal } from 'lucide-react'
import { GROUP_HEADER_HEIGHT } from '@shared/group-metrics'
import { cn } from '../../lib/utils'
import { RenameInline } from '../icon/RenameInline'
import type { GroupDrag } from './useGroupDrag'

export interface GroupHeaderProps {
  title: string
  rolledUp: boolean
  renaming: boolean
  /** Title-bar drag (useGroupDrag); absent for a header that does not move its window. */
  drag?: GroupDrag['handlers']
  dragging?: boolean
  onToggleRollUp(): void
  /** Opens the group's menu (the "…" button). */
  onOpenMenu(anchor: DOMRect): void
  /** The "…" button's accessible name (Phase 10: "Tools options"). */
  menuLabel?: string
  /** F2 renames; absent for a title that cannot be renamed (the tools widget's tool name). */
  onRename?(): void
  onRenameCommit?(title: string): void
  onRenameCancel?(): void
  /** Extra content before the buttons (Phase 10: the timer's remaining time). */
  children?: React.ReactNode
}

const ICON_BUTTON =
  'flex size-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-white/10 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:outline-none'

/**
 * A group's 36 px title bar (shared with the tools widget): the cyan uppercase title (or its
 * inline rename field), the roll-up chevron and the menu button. Double-click rolls up; F2
 * renames; dragging it moves the window.
 */
export function GroupHeader({
  title,
  rolledUp,
  renaming,
  drag,
  dragging = false,
  onToggleRollUp,
  onOpenMenu,
  menuLabel = 'Group options',
  onRename,
  onRenameCommit,
  onRenameCancel,
  children
}: GroupHeaderProps): React.JSX.Element {
  return (
    <header
      {...drag}
      onDoubleClick={(event) => {
        if ((event.target as Element).closest('button, input')) return
        onToggleRollUp()
      }}
      onKeyDown={(event) => {
        if (event.key === 'F2' && !renaming && onRename) {
          event.preventDefault()
          onRename()
        }
      }}
      style={{ height: GROUP_HEADER_HEIGHT }}
      className={cn(
        'flex shrink-0 touch-none items-center gap-1.5 pr-2 pl-3.5 select-none',
        !rolledUp && 'border-b border-white/5 [[data-theme=light]_&]:border-black/5',
        drag && (dragging ? 'cursor-grabbing' : 'cursor-grab')
      )}
    >
      {renaming && onRenameCommit && onRenameCancel ? (
        <RenameInline
          value={title}
          label={`Rename group ${title}`}
          blockInvalidChars={false}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
          className="min-w-0 flex-1 [&_input]:text-left [&_input]:font-bold [&_input]:tracking-[0.1em] [&_input]:uppercase"
        />
      ) : (
        <h2
          title={title}
          className="min-w-0 flex-1 truncate text-[11px] leading-none font-bold tracking-[0.1em] text-accent-1 uppercase"
        >
          {title}
        </h2>
      )}
      {children}
      <button
        type="button"
        aria-label={rolledUp ? 'Roll down' : 'Roll up'}
        aria-expanded={!rolledUp}
        onClick={onToggleRollUp}
        className={ICON_BUTTON}
      >
        {rolledUp ? (
          <ChevronDown aria-hidden="true" className="size-3.5" />
        ) : (
          <ChevronUp aria-hidden="true" className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        aria-label={menuLabel}
        aria-haspopup="menu"
        onClick={(event) => onOpenMenu(event.currentTarget.getBoundingClientRect())}
        className={ICON_BUTTON}
      >
        <MoreHorizontal aria-hidden="true" className="size-3.5" />
      </button>
    </header>
  )
}
