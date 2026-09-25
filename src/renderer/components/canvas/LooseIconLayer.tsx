import { useMemo } from 'react'
import type { Size } from '@shared/geometry'
import type { IconSize } from '@shared/group-metrics'
import type { DesktopItem, Point } from '@shared/schema'
import { spatialNeighbor } from '../../lib/keyboard'
import { cn } from '../../lib/utils'
import { DesktopIcon } from '../icon/DesktopIcon'
import { useItemList } from '../icon/useItemList'

export interface LooseIconLayerProps {
  /** This display's loose positions (file id → top-left, window coordinates). */
  loose: Readonly<Record<string, Point>>
  /** The items on the desktop now, by id (ids not in it are missing files: not drawn). */
  byId: Readonly<Record<string, DesktopItem>>
  cell: Size
  iconSize: IconSize
  showExtension: boolean
  /** Quick-hide: faded out and inert. */
  hidden: boolean
}

/**
 * The free-floating icons, each at its own position like the Windows desktop. One listbox for
 * the display (arrow keys go to the nearest icon in that direction). The layer itself lets
 * pointer events through to the canvas surface; only the icons catch them. Phase 8 attaches its
 * droppable to `data-loose-layer`.
 */
export function LooseIconLayer({
  loose,
  byId,
  cell,
  iconSize,
  showExtension,
  hidden
}: LooseIconLayerProps): React.JSX.Element | null {
  const placed = useMemo(
    () =>
      Object.entries(loose)
        .filter(([id]) => byId[id] !== undefined)
        // Reading order for Tab and screen readers: column by column, like the desktop.
        .sort(([, a], [, b]) => a.x - b.x || a.y - b.y)
        .map(([id, point]) => ({ item: byId[id], point })),
    [loose, byId]
  )
  const items = useMemo(() => placed.map(({ item }) => item), [placed])
  const list = useItemList({
    scope: 'desktop',
    items,
    neighbor: (_ids, current, direction) =>
      spatialNeighbor(
        placed.map(({ item, point }) => ({ id: item.id, x: point.x, y: point.y })),
        current,
        direction
      )
  })

  if (placed.length === 0) return null

  return (
    <div
      data-loose-layer=""
      role="listbox"
      aria-label="Desktop icons"
      aria-multiselectable="true"
      aria-hidden={hidden || undefined}
      inert={hidden}
      onKeyDown={list.onKeyDown}
      className={cn(
        'pointer-events-none absolute inset-0 transition-opacity duration-[180ms]',
        hidden && 'opacity-0'
      )}
    >
      {placed.map(({ item, point }) => (
        <DesktopIcon
          key={item.id}
          item={item}
          variant="loose"
          iconSize={iconSize}
          showExtension={showExtension}
          {...list.iconProps(item)}
          className="pointer-events-auto absolute"
          style={{ left: point.x, top: point.y, width: cell.width, height: cell.height }}
        />
      ))}
    </div>
  )
}
