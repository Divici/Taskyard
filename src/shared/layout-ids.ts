import type { LayoutFile } from './schema'

function without<V>(record: Record<string, V>, ids: ReadonlySet<string>): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => !ids.has(id)))
}

function mentions(layout: LayoutFile, ids: ReadonlySet<string>): boolean {
  const keyed = (record: Record<string, unknown>): boolean =>
    Object.keys(record).some((id) => ids.has(id))
  return (
    keyed(layout.paths) ||
    keyed(layout.lastSeen) ||
    layout.displays.some(
      (display) =>
        keyed(display.loose) ||
        display.groups.some((group) => group.items.some((id) => ids.has(id)))
    )
  )
}

/**
 * Removes every trace of the given file ids — group membership, loose position, last path and
 * lastSeen stamp — so a deleted file's id can never be re-used by a new file's placement.
 * Returns the input unchanged (same object) when none of the ids appear.
 */
export function forgetItemIds(layout: LayoutFile, ids: Iterable<string>): LayoutFile {
  const set = new Set(ids)
  if (set.size === 0 || !mentions(layout, set)) return layout

  return {
    ...layout,
    displays: layout.displays.map((display) => ({
      ...display,
      groups: display.groups.map((group) => ({
        ...group,
        items: group.items.filter((id) => !set.has(id))
      })),
      loose: without(display.loose, set)
    })),
    paths: without(layout.paths, set),
    lastSeen: without(layout.lastSeen, set)
  }
}

function rekey<V>(record: Record<string, V>, oldId: string, newId: string): Record<string, V> {
  if (!(oldId in record)) return record
  return Object.fromEntries(
    Object.entries(record).map(([id, value]) => [id === oldId ? newId : id, value])
  )
}

/**
 * A desktop path now holds a different file (an app saved it by writing a new file and renaming
 * it over the old one, so NTFS gave it a new id). The new id takes over the old one's group
 * membership, loose position and path, so the item keeps its place; `lastSeen` is dropped since
 * the item is present. Same object back when `oldId` is unknown or the ids are equal.
 */
export function replaceItemId(layout: LayoutFile, oldId: string, newId: string): LayoutFile {
  if (oldId === newId || !mentions(layout, new Set([oldId]))) return layout
  // The old id's placement wins: any placement the new id already had is dropped first.
  const cleared = forgetItemIds(layout, [newId])
  const lastSeen = { ...cleared.lastSeen }
  delete lastSeen[oldId]
  return {
    ...cleared,
    displays: cleared.displays.map((display) => ({
      ...display,
      groups: display.groups.map((group) =>
        group.items.includes(oldId)
          ? { ...group, items: group.items.map((id) => (id === oldId ? newId : id)) }
          : group
      ),
      loose: rekey(display.loose, oldId, newId)
    })),
    paths: rekey(cleared.paths, oldId, newId),
    lastSeen
  }
}
