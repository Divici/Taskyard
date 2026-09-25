import type { Size } from './geometry'
import {
  GROUP_BODY_PADDING,
  GROUP_BORDER,
  GROUP_HEADER_HEIGHT,
  GROUP_MIN_SIZE,
  groupColumns
} from './group-metrics'
import type { DesktopItem, Group, ItemKind, Rect } from './schema'

// First-run / "Auto-organize…": one group per kind of item, laid out in a 2×2 grid in the work
// area. Pure: the renderer applies the result with `layout.applyAutoOrganize(displayId, groups)`.

export type OrganizableItem = Pick<DesktopItem, 'id' | 'name' | 'kind'>

interface Category {
  title: string
  kinds: readonly ItemKind[]
}

/** Shortcuts (`.lnk`) count as apps: on a real desktop almost all of them start a program. */
const CATEGORIES: readonly Category[] = [
  { title: 'Apps', kinds: ['app', 'link'] },
  { title: 'Files', kinds: ['file'] },
  { title: 'Folders', kinds: ['folder'] },
  { title: 'Web links', kinds: ['url'] }
]

export const AUTO_ORGANIZE_TITLES: readonly string[] = CATEGORIES.map((c) => c.title)

/** Gap between the groups and around the grid (CSS px). */
const MARGIN = 24
/** A group is made wide enough for this many icon columns (the design's four). */
const COLUMNS = 4

export interface AutoOrganizeOptions {
  /** The work area, in the display window's coordinates. */
  area: Rect
  /** The group icon cell for the current icon size. */
  cell: Size
  now: number
  newId: () => string
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Groups for Apps, Files, Folders and Web links (empty ones skipped), each sized to its icons
 * (never taller than half the work area; it scrolls beyond that), placed left to right, top to
 * bottom in a 2×2 grid. Items are sorted by name and the groups sort by name.
 */
export function autoOrganize(
  items: readonly OrganizableItem[],
  { area, cell, now, newId }: AutoOrganizeOptions
): Group[] {
  const filled = CATEGORIES.map((category) => ({
    title: category.title,
    items: items
      .filter((item) => category.kinds.includes(item.kind))
      .sort((a, b) => collator.compare(a.name, b.name))
      .map((item) => item.id)
  })).filter((category) => category.items.length > 0)

  const slotWidth = Math.floor((area.width - MARGIN * 3) / 2)
  const slotHeight = Math.floor((area.height - MARGIN * 3) / 2)
  const width = Math.max(
    GROUP_MIN_SIZE.width,
    Math.min(slotWidth, COLUMNS * cell.width + GROUP_BODY_PADDING * 2)
  )
  const columns = groupColumns(width, cell)
  const heightFor = (count: number): number =>
    Math.max(
      GROUP_MIN_SIZE.height,
      Math.min(
        slotHeight,
        GROUP_BORDER +
          GROUP_HEADER_HEIGHT +
          GROUP_BODY_PADDING * 2 +
          Math.ceil(count / columns) * cell.height
      )
    )
  const heights = filled.map((category) => heightFor(category.items.length))
  const firstRowHeight = Math.max(...heights.slice(0, 2), 0)

  return filled.map((category, index) => ({
    id: newId(),
    title: category.title,
    x: area.x + MARGIN + (index % 2) * (width + MARGIN),
    y: area.y + MARGIN + Math.floor(index / 2) * (firstRowHeight + MARGIN),
    w: width,
    h: heights[index],
    z: index + 1,
    rolledUp: false,
    items: category.items,
    sort: 'name',
    excludeFromQuickHide: false,
    createdAt: now
  }))
}
