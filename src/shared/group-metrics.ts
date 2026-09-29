import type { Size } from './geometry'
import type { Group, Rect, SettingsFile } from './schema'

// Sizes of the group chrome and the icon grid, shared by the renderer (layout, hit testing) and
// the pure placement code (auto-organize, new-item slots), so both agree to the pixel.

export type IconSize = SettingsFile['iconSize']

/** A group's title bar; a rolled-up group is exactly this tall. */
export const GROUP_HEADER_HEIGHT = 36

/** Where a group is on screen: rolled up, just its title bar (its `h` is kept for rolling down). */
export function visibleGroupRect(group: Pick<Group, 'x' | 'y' | 'w' | 'h' | 'rolledUp'>): Rect {
  return {
    x: group.x,
    y: group.y,
    width: group.w,
    height: group.rolledUp ? GROUP_HEADER_HEIGHT : group.h
  }
}

/** The glass border (1 px top and bottom) inside a group's height. */
export const GROUP_BORDER = 2

/** Padding around a group's icon grid. */
export const GROUP_BODY_PADDING = 8

/** A group never gets smaller than this (resize stops here). */
export const GROUP_MIN_SIZE: Readonly<Size> = { width: 160, height: 120 }

/** "New group here" creates a group this big at the click point. */
export const NEW_GROUP_SIZE: Readonly<Size> = { width: 280, height: 200 }

/** A group's icon cell (square) by Settings → icon size. */
export const GROUP_CELL: Readonly<Record<IconSize, number>> = { small: 64, medium: 80, large: 96 }

/** The icon drawn inside a group's glyph tile (CSS px): 40 px at medium, as in the design. */
export const ICON_GLYPH: Readonly<Record<IconSize, number>> = { small: 32, medium: 40, large: 48 }

/** A loose icon, drawn bare like the Windows desktop's (48 px = Windows' "Medium icons"). */
export const LOOSE_GLYPH: Readonly<Record<IconSize, number>> = { small: 32, medium: 48, large: 64 }

/** Loose icons get a roomier cell than grouped ones (their labels wrap to two lines). */
export const LOOSE_CELL_EXTRA = 16

export function groupCell(size: IconSize): Size {
  return { width: GROUP_CELL[size], height: GROUP_CELL[size] }
}

export function looseCell(size: IconSize): Size {
  const side = GROUP_CELL[size] + LOOSE_CELL_EXTRA
  return { width: side, height: side }
}

/** How many icon columns fit a group `width` px wide (at least one). */
export function groupColumns(width: number, cell: Size): number {
  return Math.max(1, Math.floor((width - GROUP_BODY_PADDING * 2) / cell.width))
}
