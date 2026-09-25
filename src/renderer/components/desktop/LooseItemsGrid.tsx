import { useMemo } from 'react'
import type { DesktopItem } from '@shared/schema'
import { useItemsStore } from '../../stores/items'
import { ItemIcon, ShortcutArrow } from './ItemIcon'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const byName = (a: DesktopItem, b: DesktopItem): number => collator.compare(a.name, b.name)

/**
 * Every desktop item as an icon tile, column by column from the top-left like the Windows
 * desktop. A stand-in until the Phase 7 canvas places loose items and groups.
 */
export function LooseItemsGrid(): React.JSX.Element | null {
  const hydrated = useItemsStore((state) => state.hydrated)
  const byId = useItemsStore((state) => state.byId)
  const items = useMemo(() => Object.values(byId).sort(byName), [byId])
  if (!hydrated) return null

  return (
    <ul
      aria-label="Desktop items"
      className="grid h-full auto-cols-[84px] grid-flow-col grid-rows-[repeat(auto-fill,92px)] content-start justify-start gap-1 p-2"
    >
      {items.map((item) => (
        <li
          key={item.id}
          aria-label={item.name}
          title={item.path}
          data-item-id={item.id}
          className="flex flex-col items-center gap-1 overflow-hidden rounded-md px-1 py-1.5 text-center hover:bg-foreground/10"
        >
          <span className="relative">
            <ItemIcon item={item} />
            {(item.kind === 'link' || item.kind === 'url') && <ShortcutArrow />}
          </span>
          <span className="line-clamp-2 w-full text-xs leading-tight break-words">{item.name}</span>
        </li>
      ))}
    </ul>
  )
}
