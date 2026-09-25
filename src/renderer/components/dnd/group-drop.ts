import { GROUP_BODY_PADDING } from '@shared/group-metrics'
import type { GroupSort, Point } from '@shared/schema'

/** A group body's icon grid in window coordinates. */
export interface GridGeometry {
  left: number
  top: number
  width: number
  padding: number
  columns: number
  cellHeight: number
  /** Pixels scrolled: rows above the view still count. */
  scrollTop: number
  /** Icons in the grid. */
  count: number
}

/**
 * Where a drop at `point` inserts into the grid: before the icon under the point, or after it
 * when the point is past the icon's middle; clamped to [0, count].
 */
export function gridInsertIndex(point: Point, grid: GridGeometry): number {
  const cellWidth = (grid.width - 2 * grid.padding) / grid.columns
  const x = point.x - grid.left - grid.padding
  const y = point.y - grid.top - grid.padding + grid.scrollTop
  const column = Math.min(Math.max(Math.floor(x / cellWidth), 0), grid.columns - 1)
  const row = Math.max(Math.floor(y / grid.cellHeight), 0)
  const after = x - column * cellWidth > cellWidth / 2 ? 1 : 0
  return Math.min(Math.max(row * grid.columns + column + after, 0), grid.count)
}

/** The ids of the icons a group body shows, in display order. */
export function groupBodyIds(body: HTMLElement): string[] {
  return [...body.querySelectorAll<HTMLElement>('[data-item-id]')].map(
    (element) => element.dataset.itemId!
  )
}

/** The grid of a rendered group body (`data-columns` and `data-cell-height` from GroupBody). */
export function groupBodyGrid(body: HTMLElement): GridGeometry {
  const rect = body.getBoundingClientRect()
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    padding: GROUP_BODY_PADDING,
    columns: Math.max(1, Number(body.dataset.columns) || 1),
    cellHeight: Number(body.dataset.cellHeight) || 1,
    scrollTop: body.scrollTop,
    count: groupBodyIds(body).length
  }
}

export interface GroupDrop {
  /** Where the drop indicator goes (null: the group sorts itself, so it only lights up). */
  index: number | null
  /** The item the drop lands before (null: at the end). */
  beforeId: string | null
}

/**
 * A drop at `point` on a group: a `manual` group inserts at the index under the pointer; any
 * other sort, or a rolled-up group (no body), appends and lets the group sort.
 */
export function resolveGroupDrop(
  body: HTMLElement | null,
  point: Point,
  sort: GroupSort
): GroupDrop {
  if (body === null || sort !== 'manual') return { index: null, beforeId: null }
  const index = gridInsertIndex(point, groupBodyGrid(body))
  return { index, beforeId: groupBodyIds(body)[index] ?? null }
}
