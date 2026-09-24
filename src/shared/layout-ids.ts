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
