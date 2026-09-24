import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { emptyLayout } from '@shared/defaults'
import type { StoreSnapshot } from '@shared/ipc'
import {
  bringGroupToFront,
  deleteGroup,
  ensureDisplay,
  hasDisplay,
  moveGroupToDisplay,
  moveItems,
  putGroup,
  setLoosePosition,
  updateDisplay,
  updateGroup,
  updateTools,
  type GroupRect,
  type LooseSlots,
  type MoveTarget
} from '@shared/layout-mutations'
import type { DisplayLayout, Group, LayoutFile, Point, Rect, ToolsState } from '@shared/schema'
import { createStoreDoc, type StoreSyncOptions } from './persist'

/**
 * layout.json in the renderer. Every action is a pure change applied to the layout as it is
 * *when it is applied* (src/shared/layout-mutations.ts) and may be replayed on newer data when
 * another window saved first, so:
 * - data arguments are copied when the action is called (changing them afterwards cannot change
 *   a replay);
 * - updater arguments must derive everything from the value they receive, never from values
 *   read earlier (e.g. the view's max z, or which group holds an item);
 * - anything that depends on other groups has its own display-level action.
 */
export interface LayoutState {
  layout: LayoutFile
  /** False until main's layout has arrived; changes made before that are applied on top of it. */
  hydrated: boolean
  /** Main's layout at a revision: the loaded file or a `storage:changed` event. Never saves. */
  receive(snapshot: StoreSnapshot<'layout'>): void
  /** Makes sure the display has an entry, refreshing its last known bounds. */
  ensureDisplay(display: { id: number; bounds: Rect }): void
  /**
   * Low-level create: puts a new `group` on the display. Returns false, changing nothing, when
   * the display has no entry or the group id already exists. Phase 7's `createGroup` builds on
   * it; later edits go through the actions below.
   */
  addGroup(displayId: number, group: Group): boolean
  /**
   * Field-level edit of one group's *own* fields: `update` receives the group as it is now
   * (possibly after another window's edit) and returns it changed, e.g. `(g) => ({ ...g, x, y })`.
   * Phase 7's move, resize, rename, roll-up, sort and exclude-from-quick-hide build on this.
   * Never use it for `z` or `items`: those depend on the other groups — use `bringGroupToFront`,
   * `moveItems` and `deleteGroup`, which compute from the data they are applied to.
   */
  updateGroup(displayId: number, groupId: string, update: (group: Group) => Group): void
  /** Raises the group above every other group on its display (z computed at apply time). */
  bringGroupToFront(displayId: number, groupId: string): void
  /**
   * Moves items atomically: out of every group and the loose layer of the display, into a group
   * before an anchor item (`{groupId, beforeId?}`; end when absent) or loose at the given
   * positions. Phase 8's drops and Phase 7's remove-from-group build on this.
   */
  moveItems(displayId: number, ids: string[], target: MoveTarget): void
  /**
   * Deletes a group, never its files: the items it holds when this is applied become loose at
   * `slots(group, count, display)` (default: column-first from the group's top-left), then the
   * group is removed — one change, so an item another window just added is kept.
   */
  deleteGroup(displayId: number, groupId: string, slots?: LooseSlots): void
  /**
   * Moves a group to another display (appended on top there), its rect passed through
   * `clamp(rect, targetDisplay)` when applied. Phase 7's "Move to display" builds on this.
   */
  moveGroupToDisplay(
    fromDisplayId: number,
    groupId: string,
    toDisplayId: number,
    clamp: (rect: GroupRect, display: DisplayLayout) => GroupRect
  ): void
  /**
   * Escape hatch for a display-level change no action above covers; `update` must derive
   * everything from the display it receives, never from values read earlier.
   */
  updateDisplay(displayId: number, update: (display: DisplayLayout) => DisplayLayout): void
  /** Sets (or, with null, removes) one loose item's position. */
  setLoosePosition(displayId: number, fileId: string, point: Point | null): void
  /** Field-level edit of the display's tools widget (move, resize, roll-up, active tool). */
  updateTools(displayId: number, update: (tools: ToolsState) => ToolsState): void
  /** Forgets main's data, the revision and unsaved changes; back to unhydrated (tests). */
  reset(): void
}

function copyTarget(target: MoveTarget): MoveTarget {
  return 'loose' in target
    ? { loose: target.loose.map((point) => ({ x: point.x, y: point.y })) }
    : { groupId: target.groupId, beforeId: target.beforeId ?? null }
}

export function createLayoutStore(
  options: StoreSyncOptions<'layout'> = {}
): UseBoundStore<StoreApi<LayoutState>> {
  return create<LayoutState>()((set, get) => {
    const doc = createStoreDoc('layout', emptyLayout, (layout) => set({ layout }), options)

    return {
      layout: doc.current.view,
      hydrated: false,

      receive(snapshot) {
        doc.current.receive(snapshot)
        set({ hydrated: doc.current.hydrated })
      },

      ensureDisplay(display) {
        const entry = { id: display.id, bounds: { ...display.bounds } }
        doc.current.mutate((layout) => ensureDisplay(layout, entry))
      },

      addGroup(displayId, group) {
        const created = structuredClone(group)
        const { layout } = get()
        if (!hasDisplay(layout, displayId)) return false
        if (putGroup(layout, displayId, created) === layout) return false
        doc.current.mutate((current) => putGroup(current, displayId, created))
        return true
      },

      updateGroup(displayId, groupId, update) {
        doc.current.mutate((layout) => updateGroup(layout, displayId, groupId, update))
      },

      bringGroupToFront(displayId, groupId) {
        doc.current.mutate((layout) => bringGroupToFront(layout, displayId, groupId))
      },

      moveItems(displayId, ids, target) {
        const moving = [...ids]
        const to = copyTarget(target)
        doc.current.mutate((layout) => moveItems(layout, displayId, moving, to))
      },

      deleteGroup(displayId, groupId, slots) {
        doc.current.mutate((layout) => deleteGroup(layout, displayId, groupId, slots))
      },

      moveGroupToDisplay(fromDisplayId, groupId, toDisplayId, clamp) {
        doc.current.mutate((layout) =>
          moveGroupToDisplay(layout, fromDisplayId, groupId, toDisplayId, clamp)
        )
      },

      updateDisplay(displayId, update) {
        doc.current.mutate((layout) => updateDisplay(layout, displayId, update))
      },

      setLoosePosition(displayId, fileId, point) {
        const at = point === null ? null : { x: point.x, y: point.y }
        doc.current.mutate((layout) => setLoosePosition(layout, displayId, fileId, at))
      },

      updateTools(displayId, update) {
        doc.current.mutate((layout) => updateTools(layout, displayId, update))
      },

      reset() {
        set({ layout: doc.reset().view, hydrated: false })
      }
    }
  })
}

export const useLayoutStore = createLayoutStore()
