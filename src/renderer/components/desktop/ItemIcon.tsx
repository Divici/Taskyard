import type { DesktopItem } from '@shared/schema'
import { genericIconUrl } from '../../assets/generic-icons'
import { useItemsStore } from '../../stores/items'

/** The CSS size of a desktop icon; main extracts `ceil(64 × max scale)` px so it stays sharp. */
export const ICON_CSS_SIZE = 48

interface ItemIconProps {
  item: Pick<DesktopItem, 'id' | 'kind'>
  size?: number
}

/**
 * An item's icon: the PNG main sent (`desktop:icon`, the sharpest so far) or, until then and for
 * items main never reads, the built-in icon for its kind. Decorative: the tile carries the name.
 * `data-icon` is the icon's pixel size, `generic`, or `skeleton` while the first icons load.
 */
export function ItemIcon({ item, size = ICON_CSS_SIZE }: ItemIconProps): React.JSX.Element {
  const icon = useItemsStore((state) => state.icons[item.id])
  const loaded = useItemsStore((state) => state.iconsLoaded)
  if (!icon && !loaded) {
    // Phase 12: a skeleton tile until main's first icon pass is over (then the generic icon).
    return (
      <span
        data-icon="skeleton"
        aria-hidden="true"
        style={{ width: size, height: size }}
        className="pointer-events-none block animate-pulse rounded-[10px] bg-white/15 [[data-theme=light]_&]:bg-black/10"
      />
    )
  }
  return (
    <img
      src={icon?.dataUrl ?? genericIconUrl(item.kind)}
      alt=""
      width={size}
      height={size}
      draggable={false}
      data-icon={icon ? String(icon.px) : 'generic'}
      className="pointer-events-none object-contain select-none"
    />
  )
}

/** Explorer's shortcut overlay: a small arrow badge at the icon's bottom-left corner. */
export function ShortcutArrow(): React.JSX.Element {
  return (
    <svg
      data-shortcut-arrow=""
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="absolute bottom-0 left-0 size-4 drop-shadow-sm"
    >
      <rect x="0.5" y="0.5" width="15" height="15" rx="2" fill="#fff" stroke="#8a8f96" />
      <path
        d="M5 11.5c0-3.5 2-5.5 5.5-5.5M8.5 3.5 11 6 8.5 8.5"
        fill="none"
        stroke="#1f6fd1"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
