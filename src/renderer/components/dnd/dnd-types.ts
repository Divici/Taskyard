import type { GroupSort } from '@shared/schema'

// Phase 8 drag and drop: the constants and the data dnd-kit carries for draggables and droppables.

/** A press must move this far (px) before it becomes a drag (LOCKED Decision 8): clicks stay clicks. */
export const DRAG_ACTIVATION_DISTANCE = 6
/** How long an Explorer drop's Undo toast stays (ms). */
export const UNDO_DROP_MS = 6_000
/** At most one "is another app's window under the cursor?" question per this many ms. */
export const DRAG_OUT_PROBE_MS = 100
/** The stacked preview shows at most this many icons (the badge counts them all). */
export const PREVIEW_STACK_MAX = 3

/** The desktop itself (the whole canvas): drops there become loose icons. */
export const CANVAS_DROP_ID = 'canvas'
export const groupDropId = (groupId: string): string => `group:${groupId}`

/** Carried by every desktop icon's draggable. */
export interface ItemDragData {
  kind: 'item'
  itemId: string
}

export interface GroupDropData {
  kind: 'group'
  groupId: string
  /** Stacking rank among the groups: the topmost group under the pointer wins. */
  z: number
  sort: GroupSort
  /** The rendered icon grid (null when rolled up): drop indexes are read from it. */
  body(): HTMLElement | null
}

export interface CanvasDropData {
  kind: 'canvas'
}

export type DropData = GroupDropData | CanvasDropData
