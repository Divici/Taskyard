import { useDraggable } from '@dnd-kit/core'
import { Cloud, Lock } from 'lucide-react'
import { useMemo, type CSSProperties } from 'react'
import { ICON_GLYPH, LOOSE_GLYPH, type IconSize } from '@shared/group-metrics'
import type { DesktopItem } from '@shared/schema'
import { cn } from '../../lib/utils'
import { useUiStore } from '../../stores/ui'
import { ItemIcon, ShortcutArrow } from '../desktop/ItemIcon'
import { displayName, optionDomId } from './item-label'
import { RenameInline } from './RenameInline'

/**
 * Props the icon passes through to its element (Phase 9): the item menu's Radix trigger clones
 * the icon with its handlers, `data-state` and `ref`. Handlers dnd-kit also uses run both.
 */
type PassThroughProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  'onSelect' | 'style' | 'className' | 'role' | 'id' | 'title' | 'tabIndex' | 'children'
>

export interface DesktopIconProps extends PassThroughProps {
  ref?: React.Ref<HTMLDivElement>
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
  /** Phase 9: why the last rename failed, and the name that failed (the field reopens on it). */
  renameError?: string
  renameDraft?: string
  style?: CSSProperties
  className?: string
}

type Handler = (event: never) => void

/** Handlers present in both sets, each calling `first` then `second`. */
function bothHandlers(
  first: Readonly<Record<string, unknown>>,
  second: Readonly<Record<string, unknown>> | undefined
): Record<string, Handler> {
  const merged: Record<string, Handler> = {}
  for (const [name, handler] of Object.entries(second ?? {})) {
    const own = first[name]
    if (typeof own !== 'function' || typeof handler !== 'function') continue
    merged[name] = (event) => {
      ;(own as Handler)(event)
      ;(handler as Handler)(event)
    }
  }
  return merged
}

/** Sets every ref (a callback or an object) to `node`. */
function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    }
  }
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
  renameError,
  renameDraft,
  style,
  className,
  ref,
  ...passThrough
}: DesktopIconProps): React.JSX.Element {
  // Phase 8: every icon is draggable (dnd-kit, 6 px before a press becomes a drag; not while its
  // name is being edited). Only the listeners are spread: the option keeps its own role and tab
  // stop, and gets dnd-kit's instructions as its description.
  const { setNodeRef, listeners, attributes } = useDraggable({
    id: item.id,
    data: { kind: 'item', itemId: item.id },
    disabled: renaming
  })
  const nodeRef = useMemo(() => mergeRefs(setNodeRef, ref), [setNodeRef, ref])
  const dragSource = useUiStore((state) => state.drag?.ids.includes(item.id) ?? false)
  const name = displayName(item, showExtension)
  const grouped = variant === 'group'
  const glyph = (grouped ? ICON_GLYPH : LOOSE_GLYPH)[iconSize]

  return (
    <div
      {...passThrough}
      ref={nodeRef}
      {...listeners}
      {...bothHandlers(passThrough, listeners)}
      aria-describedby={attributes['aria-describedby'] || undefined}
      id={optionDomId(scope, item.id)}
      role="option"
      aria-selected={selected}
      aria-label={name}
      tabIndex={tabbable ? 0 : -1}
      title={item.path}
      data-item-id={item.id}
      data-selected={selected || undefined}
      data-drag-source={dragSource || undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
      style={style}
      className={cn(
        'group/icon relative flex cursor-default flex-col items-center gap-1.5 rounded-[10px] px-1 pt-1.5 pb-1 text-center outline-none select-none',
        'transition-colors duration-150 hover:bg-white/10',
        'focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:ring-offset-0',
        selected && 'bg-accent-2/25 ring-1 ring-accent-1/50 hover:bg-accent-2/30',
        // Left in place, faded, while its preview follows the pointer.
        dragSource && 'opacity-40',
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
          error={renameError}
          initialDraft={renameDraft}
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
