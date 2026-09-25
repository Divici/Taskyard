import { Cloud, Lock } from 'lucide-react'
import type { CSSProperties } from 'react'
import { ICON_GLYPH, LOOSE_GLYPH, type IconSize } from '@shared/group-metrics'
import type { DesktopItem } from '@shared/schema'
import { cn } from '../../lib/utils'
import { ItemIcon, ShortcutArrow } from '../desktop/ItemIcon'
import { displayName, optionDomId } from './item-label'
import { RenameInline } from './RenameInline'

export interface DesktopIconProps {
  item: DesktopItem
  /** `group`: glass glyph tile, one-line label; `loose`: bare icon, two-line label (Windows). */
  variant: 'group' | 'loose'
  iconSize: IconSize
  showExtension: boolean
  selected: boolean
  /** Roving focus: exactly one option per list is in the Tab order. */
  tabbable: boolean
  renaming?: boolean
  /** Which list the option is in (the DOM id must be unique per window). */
  scope?: string
  onSelect?(event: React.MouseEvent<HTMLElement>): void
  onOpen?(): void
  onRenameCommit?(name: string): void
  onRenameCancel?(): void
  style?: CSSProperties
  className?: string
}

const BADGE =
  'absolute flex size-4 items-center justify-center rounded-full bg-black/70 text-white ring-1 ring-white/30'

/**
 * One desktop item: its icon (with the shortcut arrow and read-only / online-only badges) and
 * its label, or the inline rename field while renaming. An `option` in the group's or the
 * desktop's listbox; selection comes from the parent (ui store).
 */
export function DesktopIcon({
  item,
  variant,
  iconSize,
  showExtension,
  selected,
  tabbable,
  renaming = false,
  scope = 'desktop',
  onSelect,
  onOpen,
  onRenameCommit,
  onRenameCancel,
  style,
  className
}: DesktopIconProps): React.JSX.Element {
  const name = displayName(item, showExtension)
  const grouped = variant === 'group'
  const glyph = (grouped ? ICON_GLYPH : LOOSE_GLYPH)[iconSize]

  return (
    <div
      id={optionDomId(scope, item.id)}
      role="option"
      aria-selected={selected}
      aria-label={name}
      tabIndex={tabbable ? 0 : -1}
      title={item.path}
      data-item-id={item.id}
      data-selected={selected || undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
      style={style}
      className={cn(
        'group/icon relative flex cursor-default flex-col items-center gap-1.5 rounded-[10px] px-1 pt-1.5 pb-1 text-center outline-none select-none',
        'transition-colors duration-150 hover:bg-white/10',
        'focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:ring-offset-0',
        selected && 'bg-accent-2/25 ring-1 ring-accent-1/50 hover:bg-accent-2/30',
        className
      )}
    >
      <span
        className={cn(
          'relative flex shrink-0 items-center justify-center',
          grouped &&
            'rounded-[12px] border border-white/5 bg-white/5 transition-transform duration-200 group-hover/icon:scale-105 group-hover/icon:border-accent-2 group-hover/icon:bg-white/10 [[data-theme=light]_&]:border-black/5 [[data-theme=light]_&]:bg-white/50'
        )}
        style={grouped ? { width: glyph + 8, height: glyph + 8 } : undefined}
      >
        <ItemIcon item={item} size={glyph} />
        {(item.kind === 'link' || item.kind === 'url') && <ShortcutArrow />}
        {item.readonly && (
          <span
            data-badge="readonly"
            title="Read-only: Windows won’t let you rename or delete this item"
            className={cn(BADGE, '-top-1 -right-1')}
          >
            <Lock aria-hidden="true" className="size-2.5" />
          </span>
        )}
        {item.placeholder && (
          <span
            data-badge="placeholder"
            title="Online-only: stored in the cloud until you open it"
            className={cn(BADGE, '-right-1 -bottom-1')}
          >
            <Cloud aria-hidden="true" className="size-2.5" />
          </span>
        )}
      </span>
      {renaming ? (
        <RenameInline
          value={name}
          label={`Rename ${name}`}
          readOnly={item.readonly}
          onCommit={(next) => onRenameCommit?.(next)}
          onCancel={() => onRenameCancel?.()}
        />
      ) : (
        <span
          title={name}
          className={cn(
            'w-full leading-tight break-words',
            grouped
              ? 'truncate text-[10px] text-text-secondary'
              : 'line-clamp-2 text-xs text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.9),0_0_6px_rgb(0_0_0/0.6)]'
          )}
        >
          {name}
        </span>
      )}
    </div>
  )
}
