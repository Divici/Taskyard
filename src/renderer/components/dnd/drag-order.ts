import type { DesktopItem, DisplayLayout } from '@shared/schema'
import { sortItems } from '../../lib/sort-items'

/**
 * A multi-selection in the order it is shown, which a drop keeps: the groups from the bottom of
 * the stack up, each in its display order (its sort), then the loose icons column-first. Ids the
 * display does not place follow in the order given.
 */
export function dragOrder(
  ids: readonly string[],
  display: Pick<DisplayLayout, 'groups' | 'loose'>,
  byId: Readonly<Record<string, DesktopItem>>
): string[] {
  const wanted = new Set(ids)
  const ordered: string[] = []
  for (const group of [...display.groups].sort((a, b) => a.z - b.z)) {
    const members = group.items
      .filter((id) => wanted.has(id))
      .map((id) => byId[id])
      .filter((item): item is DesktopItem => item !== undefined)
    for (const item of sortItems(members, group.sort)) ordered.push(item.id)
    // Members the items store does not know (yet) keep their stored order.
    for (const id of group.items) if (wanted.has(id) && !byId[id]) ordered.push(id)
  }
  const loose = Object.entries(display.loose)
    .filter(([id]) => wanted.has(id))
    .sort(([, a], [, b]) => a.x - b.x || a.y - b.y)
  for (const [id] of loose) ordered.push(id)
  const placed = new Set(ordered)
  for (const id of ids) if (!placed.has(id)) ordered.push(id)
  return [...new Set(ordered)]
}
