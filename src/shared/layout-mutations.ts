import { newDisplayLayout } from './defaults'
import type { DisplayLayout, Group, LayoutFile, Point, Rect, ToolsState } from './schema'

// Pure layout changes. The renderer's sync client replays them on newer data whenever another
// window saved first (src/shared/sync-doc.ts), so each one re-checks its own preconditions,
// changes only what it is about and returns the same object when nothing changes. Nothing may be
// computed from a value read earlier: an edit takes an updater of the *current* group / widget,
// and anything that depends on the rest of the display (the top z, which group holds an item)
// is a display-level primitive that looks at the file it is applied to.

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Applies a display-level updater (escape hatch for changes no primitive below covers); the same
 * layout back when the display is unknown or unchanged. `update` must derive everything from the
 * display it receives.
 */
export function updateDisplay(
  layout: LayoutFile,
  displayId: number,
  update: (display: DisplayLayout) => DisplayLayout
): LayoutFile {
  const index = layout.displays.findIndex((display) => display.displayId === displayId)
  if (index === -1) return layout
  const next = update(layout.displays[index])
  if (next === layout.displays[index]) return layout
  return {
    ...layout,
    displays: layout.displays.map((display, i) => (i === index ? next : display))
  }
}

export function hasDisplay(layout: LayoutFile, displayId: number): boolean {
  return layout.displays.some((display) => display.displayId === displayId)
}

/** Adds an entry for the display, or refreshes its last known bounds. */
export function ensureDisplay(
  layout: LayoutFile,
  display: { id: number; bounds: Rect }
): LayoutFile {
  if (!hasDisplay(layout, display.id)) {
    return {
      ...layout,
      displays: [...layout.displays, newDisplayLayout(display.id, display.bounds)]
    }
  }
  return updateDisplay(layout, display.id, (entry) =>
    sameRect(entry.bounds, display.bounds) ? entry : { ...entry, bounds: { ...display.bounds } }
  )
}

/**
 * Creates `group` on the display. Never replaces an existing group with the same id (that would
 * undo another window's edits on replay); edits go through `updateGroup`.
 */
export function putGroup(layout: LayoutFile, displayId: number, group: Group): LayoutFile {
  return updateDisplay(layout, displayId, (display) =>
    display.groups.some((existing) => existing.id === group.id)
      ? display
      : { ...display, groups: [...display.groups, group] }
  )
}

/**
 * Applies a field-level updater to one group's own fields (position, size, title, roll-up, sort,
 * quick-hide), e.g. `(g) => ({ ...g, x, y })`. Replayed on newer data it keeps another window's
 * edit of other fields. No-op if the group is gone. Not for `z` (use `bringGroupToFront`) or
 * `items` (use `moveItems`): both depend on the other groups.
 */
export function updateGroup(
  layout: LayoutFile,
  displayId: number,
  groupId: string,
  update: (group: Group) => Group
): LayoutFile {
  return updateDisplay(layout, displayId, (display) => {
    const index = display.groups.findIndex((group) => group.id === groupId)
    if (index === -1) return display
    const next = update(display.groups[index])
    if (next === display.groups[index]) return display
    return { ...display, groups: display.groups.map((group, i) => (i === index ? next : group)) }
  })
}

/** Sets (or, with null, removes) one loose item's position; other items are untouched. */
export function setLoosePosition(
  layout: LayoutFile,
  displayId: number,
  fileId: string,
  point: Point | null
): LayoutFile {
  return updateDisplay(layout, displayId, (display) => {
    const current = display.loose[fileId]
    if (point === null) {
      if (current === undefined) return display
      const loose = { ...display.loose }
      delete loose[fileId]
      return { ...display, loose }
    }
    if (current && current.x === point.x && current.y === point.y) return display
    return { ...display, loose: { ...display.loose, [fileId]: { x: point.x, y: point.y } } }
  })
}

/** Applies a field-level updater to the display's tools widget (move, resize, roll-up, tab). */
export function updateTools(
  layout: LayoutFile,
  displayId: number,
  update: (tools: ToolsState) => ToolsState
): LayoutFile {
  return updateDisplay(layout, displayId, (display) => {
    const tools = update(display.tools)
    return tools === display.tools ? display : { ...display, tools }
  })
}

/**
 * Raises the group above every other group on the display, with `z` computed from the file it is
 * applied to, so two windows raising different groups at once end with distinct z. No-op if the
 * group is already strictly on top, gone, or the display unknown.
 */
export function bringGroupToFront(
  layout: LayoutFile,
  displayId: number,
  groupId: string
): LayoutFile {
  return updateDisplay(layout, displayId, (display) => {
    const target = display.groups.find((group) => group.id === groupId)
    if (!target) return display
    const others = display.groups.filter((group) => group.id !== groupId)
    const top = others.reduce((max, group) => Math.max(max, group.z), -Infinity)
    if (target.z > top) return display
    const z = top + 1
    return {
      ...display,
      groups: display.groups.map((group) => (group.id === groupId ? { ...group, z } : group))
    }
  })
}

/**
 * Where `moveItems` puts the items: into a group before the item `beforeId` (resolved when the
 * change is applied; absent, null or no longer there → at the end), or loose at one position per
 * id. An anchor, not a numeric index, so a replay after another window changed the group still
 * lands next to the same neighbour.
 */
export type MoveTarget = { groupId: string; beforeId?: string | null } | { loose: Point[] }

function sameItems(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

function samePoints(a: Record<string, Point>, b: Record<string, Point>): boolean {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((id) => b[id] !== undefined && a[id].x === b[id].x && a[id].y === b[id].y)
  )
}

/**
 * The display with `groups` (unchanged ones passed through as the same objects) and `loose`
 * swapped in; the display itself when nothing changed at all.
 */
function withContents(
  display: DisplayLayout,
  groups: Group[],
  loose: Record<string, Point>
): DisplayLayout {
  const groupsSame = groups.every((group, index) => group === display.groups[index])
  const looseSame = samePoints(display.loose, loose)
  if (groupsSame && looseSame) return display
  return {
    ...display,
    groups: groupsSame ? display.groups : groups,
    loose: looseSame ? display.loose : loose
  }
}

/**
 * Moves items atomically: removes the ids (each once, first occurrence wins) from every group
 * and from the loose layer of the display, then puts them at the target — into a group before
 * the anchor, or loose at the matching positions. Because removal and insertion are one change,
 * two windows moving the same item at once leave it in exactly one place. If the anchor is one
 * of the moved items, the next unmoved item after it anchors instead. Returns the same object
 * when nothing changes (no ids, a drop in place), and is a no-op if the target group is gone
 * (deleted elsewhere) or the display unknown.
 */
export function moveItems(
  layout: LayoutFile,
  displayId: number,
  ids: readonly string[],
  target: MoveTarget
): LayoutFile {
  if ('loose' in target && target.loose.length !== ids.length) {
    throw new Error(`moveItems: ${ids.length} ids but ${target.loose.length} positions`)
  }
  // Each id once, in first-occurrence order (with its own position for a loose target).
  const moving = new Set<string>()
  const order: string[] = []
  const positions = new Map<string, Point>()
  ids.forEach((id, index) => {
    if (moving.has(id)) return
    moving.add(id)
    order.push(id)
    if ('loose' in target) positions.set(id, target.loose[index])
  })
  if (order.length === 0) return layout

  const intoId = 'groupId' in target ? target.groupId : undefined
  const beforeId = 'groupId' in target ? (target.beforeId ?? null) : null

  return updateDisplay(layout, displayId, (display) => {
    const into = intoId === undefined ? undefined : display.groups.find((g) => g.id === intoId)
    if (intoId !== undefined && !into) return display

    // Resolve the anchor now, on this data: the item itself, or the next one not being moved.
    let anchor: string | undefined
    if (into && beforeId !== null) {
      const from = into.items.indexOf(beforeId)
      if (from !== -1) anchor = into.items.slice(from).find((id) => !moving.has(id))
    }

    const loose: Record<string, Point> = Object.fromEntries(
      Object.entries(display.loose).filter(([id]) => !moving.has(id))
    )
    const groups = display.groups.map((group) => {
      const remaining = group.items.some((id) => moving.has(id))
        ? group.items.filter((id) => !moving.has(id))
        : group.items
      if (group !== into) {
        return remaining === group.items ? group : { ...group, items: remaining }
      }
      const at = anchor === undefined ? remaining.length : remaining.indexOf(anchor)
      const items = [...remaining.slice(0, at), ...order, ...remaining.slice(at)]
      return sameItems(items, group.items) ? group : { ...group, items }
    })
    if ('loose' in target) {
      for (const id of order) {
        const point = positions.get(id)!
        loose[id] = { x: point.x, y: point.y }
      }
    }
    return withContents(display, groups, loose)
  })
}

/** Grid cell for loose icons when nothing better is known (the medium icon size). */
export const DEFAULT_LOOSE_CELL = { width: 96, height: 96 } as const

/** Where a deleted group's items go: one position per item. */
export type LooseSlots = (group: Group, count: number, display: DisplayLayout) => Point[]

/**
 * Column-first positions starting at the group's top-left, as the Windows desktop fills icons:
 * down as many rows as fit the group's height (at least one), then the next column.
 */
export function columnFirstSlots(
  cell: { width: number; height: number } = DEFAULT_LOOSE_CELL
): LooseSlots {
  return (group, count) => {
    const rows = Math.max(1, Math.floor(group.h / cell.height))
    return Array.from({ length: count }, (_, index) => ({
      x: group.x + Math.floor(index / rows) * cell.width,
      y: group.y + (index % rows) * cell.height
    }))
  }
}

/**
 * Deletes a group without deleting files: its items *as they are when this is applied* (so one
 * another window just added is kept) become loose at `slots(group, count, display)`, computed at
 * apply time from the group's rect, and the group is removed — one change. No-op if the group is
 * already gone. Existing loose positions are kept.
 */
export function deleteGroup(
  layout: LayoutFile,
  displayId: number,
  groupId: string,
  slots: LooseSlots = columnFirstSlots()
): LayoutFile {
  return updateDisplay(layout, displayId, (display) => {
    const doomed = display.groups.find((group) => group.id === groupId)
    if (!doomed) return display
    const items = doomed.items.filter((id) => display.loose[id] === undefined)
    const points = slots(doomed, items.length, display)
    if (points.length !== items.length) {
      throw new Error(`deleteGroup: ${items.length} items but ${points.length} slots`)
    }
    const loose = { ...display.loose }
    items.forEach((id, index) => {
      loose[id] = { x: points[index].x, y: points[index].y }
    })
    return { ...display, groups: display.groups.filter((group) => group !== doomed), loose }
  })
}

/** A group's rectangle, as `moveGroupToDisplay`'s clamp sees it. */
export type GroupRect = Pick<Group, 'x' | 'y' | 'w' | 'h'>

/**
 * Moves a group to another display as one change over the whole file: removes it from the
 * source display and appends it to the target on top (z above every group there), with its rect
 * passed through `clamp(rect, targetDisplay)` *when this is applied* — so it moves the group as
 * it is then, including another window's edits. No-op for the same display, a missing group or
 * an unknown display.
 */
export function moveGroupToDisplay(
  layout: LayoutFile,
  fromDisplayId: number,
  groupId: string,
  toDisplayId: number,
  clamp: (rect: GroupRect, display: DisplayLayout) => GroupRect
): LayoutFile {
  if (fromDisplayId === toDisplayId) return layout
  const from = layout.displays.find((display) => display.displayId === fromDisplayId)
  const to = layout.displays.find((display) => display.displayId === toDisplayId)
  const group = from?.groups.find((candidate) => candidate.id === groupId)
  if (!from || !to || !group) return layout

  const rect = clamp({ x: group.x, y: group.y, w: group.w, h: group.h }, to)
  const z = to.groups.reduce((max, candidate) => Math.max(max, candidate.z), 0) + 1
  const moved: Group = { ...group, x: rect.x, y: rect.y, w: rect.w, h: rect.h, z }
  return {
    ...layout,
    displays: layout.displays.map((display) => {
      if (display === from) {
        return { ...display, groups: display.groups.filter((candidate) => candidate !== group) }
      }
      if (display === to) return { ...display, groups: [...display.groups, moved] }
      return display
    })
  }
}
