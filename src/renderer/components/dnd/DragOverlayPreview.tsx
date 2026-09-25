import { LOOSE_GLYPH, type IconSize } from '@shared/group-metrics'
import type { DesktopItem } from '@shared/schema'
import { cn } from '../../lib/utils'
import { ItemIcon, ShortcutArrow } from '../desktop/ItemIcon'
import { displayName } from '../icon/item-label'
import { PREVIEW_STACK_MAX } from './dnd-types'

export interface DragOverlayPreviewProps {
  /** The dragged items, the grabbed one first. */
  items: readonly DesktopItem[]
  iconSize: IconSize
  showExtension: boolean
}

/** Each layer under the top one sits this much further down-right (px), fanned slightly. */
const LAYER_OFFSET = 5
const LAYER_TURN_DEG = 4

/**
 * What follows the pointer while icons are dragged: the grabbed icon on top of (at most) two
 * more, fanned like a stack of cards, its label below, and a count badge when more than one item
 * moves. Rendered in dnd-kit's DragOverlay, which the canvas portals outside every `.glass`
 * (their `contain: paint` would clip it). Decorative: dnd-kit announces the drag.
 */
export function DragOverlayPreview({
  items,
  iconSize,
  showExtension
}: DragOverlayPreviewProps): React.JSX.Element | null {
  const top = items[0]
  if (!top) return null
  const glyph = LOOSE_GLYPH[iconSize]
  const layers = items.slice(0, PREVIEW_STACK_MAX)

  return (
    <div
      data-drag-overlay=""
      // No blur under a moving preview (it would re-blur every frame).
      data-dragging=""
      aria-hidden="true"
      className="pointer-events-none flex w-full cursor-grabbing flex-col items-center gap-1.5 pt-1.5 select-none"
    >
      <span className="relative" style={{ width: glyph, height: glyph }}>
        {/* Bottom layer first, so the grabbed icon paints on top. */}
        {[...layers].reverse().map((item) => {
          const depth = layers.indexOf(item)
          return (
            <span
              key={item.id}
              data-stack-layer={depth}
              className={cn(
                'absolute inset-0 flex items-center justify-center rounded-[12px]',
                depth > 0 && 'bg-white/10 shadow-md ring-1 ring-white/20'
              )}
              style={{
                transform: `translate(${depth * LAYER_OFFSET}px, ${depth * LAYER_OFFSET}px) rotate(${depth * LAYER_TURN_DEG}deg)`,
                opacity: depth === 0 ? 1 : 0.85 - depth * 0.15
              }}
            >
              <ItemIcon item={item} size={glyph} />
              {depth === 0 && (item.kind === 'link' || item.kind === 'url') && <ShortcutArrow />}
            </span>
          )
        })}
        {items.length > 1 && (
          <span
            data-count-badge=""
            className="absolute -top-2 -right-3 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-1 px-1.5 text-[11px] leading-none font-semibold text-black shadow-md ring-2 ring-black/30"
          >
            {items.length}
          </span>
        )}
      </span>
      <span className="line-clamp-2 max-w-full px-1 text-center text-xs leading-tight text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.9),0_0_6px_rgb(0_0_0/0.6)]">
        {displayName(top, showExtension)}
      </span>
    </div>
  )
}
