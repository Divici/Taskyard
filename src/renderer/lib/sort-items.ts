import type { DesktopItem, GroupSort, ItemKind } from '@shared/schema'
import type { LooseSortKey } from '@shared/shell-menu'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** "Type" order: folders first, like Explorer, then programs, shortcuts, links and files. */
const KIND_ORDER: Readonly<Record<ItemKind, number>> = {
  folder: 0,
  app: 1,
  link: 2,
  url: 3,
  file: 4
}

const byName = (a: DesktopItem, b: DesktopItem): number => collator.compare(a.name, b.name)

/**
 * A group's items in display order: `manual` keeps the given (stored) order; `name`, `type`
 * (kind, then extension, then name) and `modified` (newest first) sort a copy.
 */
export function sortItems(items: readonly DesktopItem[], sort: GroupSort): DesktopItem[] {
  const sorted = [...items]
  switch (sort) {
    case 'manual':
      return sorted
    case 'name':
      return sorted.sort(byName)
    case 'type':
      return sorted.sort(
        (a, b) =>
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || collator.compare(a.ext, b.ext) || byName(a, b)
      )
    case 'modified':
      return sorted.sort((a, b) => b.mtimeMs - a.mtimeMs || byName(a, b))
  }
}

/** Loose icons in name order ("Sort loose icons"). */
export function sortByName(items: readonly DesktopItem[]): DesktopItem[] {
  return [...items].sort(byName)
}

/**
 * Loose icons for the native Desktop menu's Sort by ▸ (Phase 3): Name, Item type and Date
 * modified as in groups; Size puts folders first (they have no size), then the smallest file.
 */
export function sortLoose(items: readonly DesktopItem[], key: LooseSortKey): DesktopItem[] {
  if (key !== 'size') return sortItems(items, key)
  const folder = (item: DesktopItem): number => (item.kind === 'folder' ? 0 : 1)
  return [...items].sort(
    (a, b) => folder(a) - folder(b) || a.sizeBytes - b.sizeBytes || byName(a, b)
  )
}
