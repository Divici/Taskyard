import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { emptyLayout } from '@shared/defaults'
import { clampRect, type Size } from '@shared/geometry'
import type { StoreSnapshot } from '@shared/ipc'
import {
  applyAutoOrganize,
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
import {
  arrangeLoose,
  placeNewItems,
  reconcileLayout,
  type PlaceTarget,
  type PresentItem,
  type ReconcileOptions
} from '@shared/placement'
import type {
  DisplayLayout,
  Group,
  GroupSort,
  LayoutFile,
  Point,
  Rect,
  ToolsState
} from '@shared/schema'
import { placeItems, restorePlacements, type ItemPlacement } from '@shared/drop-placement'
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
  /**
   * Makes sure the display has an entry, refreshing its last known bounds; `tools` is the tools
   * widget's start (placement, visibility) for a display seen for the first time.
   */
  ensureDisplay(display: { id: number; bounds: Rect; tools?: Partial<ToolsState> }): void
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

  // ---- Phase 7: groups, placement, reconcile -------------------------------------------------

  /**
   * Creates a group at `rect` on top of the display, titled `title` ("New group"), and moves
   * `ids` into it (out of wherever they are) — one save. Returns the new id, or null when the
   * display has no entry.
   */
  createGroup(displayId: number, rect: Rect, ids?: string[], title?: string): string | null
  renameGroup(displayId: number, groupId: string, title: string): void
  moveGroup(displayId: number, groupId: string, to: Point): void
  resizeGroup(displayId: number, groupId: string, rect: Rect): void
  /** Rolls the group up to its title bar, or back down (width and height are kept). */
  toggleRollUp(displayId: number, groupId: string): void
  setGroupSort(displayId: number, groupId: string, sort: GroupSort): void
  setExcludeFromQuickHide(displayId: number, groupId: string, exclude: boolean): void
  /**
   * Brings the layout in line with the items on disk (src/shared/placement.ts `reconcileLayout`):
   * stamps/clears `lastSeen`, prunes ids missing > 30 days, follows paths and places unplaced
   * present ids on `options.place`. Only the primary display's window calls it (single writer;
   * lib/reconcile-sync.ts). Saves nothing when the layout already agrees.
   */
  reconcile(present: PresentItem[], options: ReconcileOptions): void
  /** Places items no display places yet as loose icons in the first free cells of `place`. */
  placeNewItems(items: PresentItem[], place: PlaceTarget): void
  /** Adds auto-organized groups (src/shared/auto-organize.ts), taking only still-loose items. */
  applyAutoOrganize(displayId: number, groups: Group[]): void
  /** Lays the display's loose icons out again, column-first around the groups, in `order`. */
  arrangeLoose(displayId: number, order: string[], area: Rect, cell: Size): void

  // ---- Phase 8: drops ------------------------------------------------------------------------

  /**
   * Places items on `displayId` at `target` (like `moveItems`) and takes them off every other
   * display first: an Explorer drop's new files may already have been placed by reconcile.
   */
  placeItems(displayId: number, ids: string[], target: MoveTarget): void
  /** Puts items back where `placementsOf` found them (Undo); ids that were nowhere are forgotten. */
  restorePlacements(snapshot: ItemPlacement[]): void

  /** Forgets main's data, the revision and unsaved changes; back to unhydrated (tests). */
  reset(): void
}

/** A `moveGroupToDisplay` clamp that keeps the group inside `area` (the target's work area). */
export function clampGroupInto(area: Rect): (rect: GroupRect) => GroupRect {
  return (rect) => {
    const clamped = clampRect({ x: rect.x, y: rect.y, width: rect.w, height: rect.h }, area)
    return { x: clamped.x, y: clamped.y, w: clamped.width, h: clamped.height }
  }
}

/** A field-level group edit that returns the same group when nothing changes. */
function patchGroup(patch: Partial<Group>): (group: Group) => Group {
  return (group) =>
    (Object.keys(patch) as Array<keyof Group>).every((key) => group[key] === patch[key])
      ? group
      : { ...group, ...patch }
}

const copyPresent = (items: PresentItem[]): PresentItem[] =>
  items.map(({ id, path, name }) => ({ id, path, name }))

const copyPlace = (place: PlaceTarget): PlaceTarget => ({
  displayId: place.displayId,
  area: { ...place.area },
  cell: { ...place.cell }
})

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
        const entry = {
          id: display.id,
          bounds: { ...display.bounds },
          ...(display.tools ? { tools: { ...display.tools } } : {})
        }
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

      createGroup(displayId, rect, ids = [], title = 'New group') {
        const group: Group = {
          id: crypto.randomUUID(),
          title,
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          // Raised to the top when applied (bringGroupToFront computes z from the data then).
          z: 0,
          rolledUp: false,
          items: [],
          sort: 'manual',
          excludeFromQuickHide: false,
          createdAt: Date.now()
        }
        if (!get().addGroup(displayId, group)) return null
        get().bringGroupToFront(displayId, group.id)
        if (ids.length > 0) get().moveItems(displayId, ids, { groupId: group.id })
        return group.id
      },

      renameGroup(displayId, groupId, title) {
        get().updateGroup(displayId, groupId, patchGroup({ title }))
      },

      moveGroup(displayId, groupId, to) {
        get().updateGroup(displayId, groupId, patchGroup({ x: to.x, y: to.y }))
      },

      resizeGroup(displayId, groupId, rect) {
        get().updateGroup(
          displayId,
          groupId,
          patchGroup({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })
        )
      },

      toggleRollUp(displayId, groupId) {
        get().updateGroup(displayId, groupId, (group) => ({ ...group, rolledUp: !group.rolledUp }))
      },

      setGroupSort(displayId, groupId, sort) {
        get().updateGroup(displayId, groupId, patchGroup({ sort }))
      },

      setExcludeFromQuickHide(displayId, groupId, exclude) {
        get().updateGroup(displayId, groupId, patchGroup({ excludeFromQuickHide: exclude }))
      },

      reconcile(present, options) {
        const items = copyPresent(present)
        const opts: ReconcileOptions = {
          now: options.now,
          place: options.place ? copyPlace(options.place) : null
        }
        doc.current.mutate((layout) => reconcileLayout(layout, items, opts))
      },

      placeNewItems(items, place) {
        const fresh = copyPresent(items)
        const target = copyPlace(place)
        doc.current.mutate((layout) => placeNewItems(layout, fresh, target))
      },

      applyAutoOrganize(displayId, groups) {
        const created = structuredClone(groups)
        doc.current.mutate((layout) => applyAutoOrganize(layout, displayId, created))
      },

      arrangeLoose(displayId, order, area, cell) {
        const ids = [...order]
        const within = { ...area }
        const size = { ...cell }
        doc.current.mutate((layout) => arrangeLoose(layout, displayId, ids, within, size))
      },

      placeItems(displayId, ids, target) {
        const moving = [...ids]
        const to = copyTarget(target)
        doc.current.mutate((layout) => placeItems(layout, displayId, moving, to))
      },

      restorePlacements(snapshot) {
        const entries = structuredClone(snapshot)
        doc.current.mutate((layout) => restorePlacements(layout, entries))
      },

      reset() {
        set({ layout: doc.reset().view, hydrated: false })
      }
    }
  })
}

export const useLayoutStore = createLayoutStore()
