import { autoOrganize } from '@shared/auto-organize'
import { clampRect, snapRect, snapValue } from '@shared/geometry'
import {
  GROUP_MIN_SIZE,
  NEW_GROUP_SIZE,
  groupCell,
  looseCell,
  type IconSize
} from '@shared/group-metrics'
import type { DesktopItem, Point, Rect } from '@shared/schema'
import { useItemsStore } from '../stores/items'
import { useLayoutStore } from '../stores/layout'
import { useUiStore } from '../stores/ui'
import { getBridge } from './bridge'
import { sortByName } from './sort-items'

// Desktop-level actions of the canvas (its menu, the marquee, the empty-desktop hint).

/** Creates a group and opens its inline rename, like Explorer's "New folder". */
function createAndRename(displayId: number, rect: Rect, ids: string[] = []): string | null {
  const id = useLayoutStore.getState().createGroup(displayId, rect, ids)
  if (id !== null) useUiStore.getState().startRename({ kind: 'group', id })
  return id
}

/** "New group here": a 280 × 200 group at the click point, inside the work area. */
export function newGroupAt(
  displayId: number,
  point: Point,
  area: Rect,
  snap: boolean
): string | null {
  const at = snap ? { x: snapValue(point.x), y: snapValue(point.y) } : point
  const rect = clampRect({ ...at, ...NEW_GROUP_SIZE }, area)
  return createAndRename(displayId, rect, [])
}

/**
 * A group drawn with the marquee: the marquee's bounds (snapped, grown to the minimum size,
 * inside the work area) holding the loose icons it contains.
 */
export function groupFromMarquee(
  displayId: number,
  marquee: Rect,
  area: Rect,
  snap: boolean,
  ids: string[]
): string | null {
  const snapped = snap ? snapRect(marquee) : marquee
  const rect = clampRect(
    {
      ...snapped,
      width: Math.max(snapped.width, GROUP_MIN_SIZE.width),
      height: Math.max(snapped.height, GROUP_MIN_SIZE.height)
    },
    area
  )
  return createAndRename(displayId, rect, ids)
}

/** The display's loose icons that are on the desktop now. */
function looseItems(displayId: number): DesktopItem[] {
  const display = useLayoutStore
    .getState()
    .layout.displays.find((entry) => entry.displayId === displayId)
  const byId = useItemsStore.getState().byId
  return Object.keys(display?.loose ?? {})
    .map((id) => byId[id])
    .filter((item): item is DesktopItem => item !== undefined)
}

/** Groups this display's loose icons by type (Apps, Files, Folders, Web links). */
export function autoOrganizeDisplay(displayId: number, area: Rect, iconSize: IconSize): void {
  const groups = autoOrganize(looseItems(displayId), {
    area,
    cell: groupCell(iconSize),
    now: Date.now(),
    newId: () => crypto.randomUUID()
  })
  if (groups.length > 0) useLayoutStore.getState().applyAutoOrganize(displayId, groups)
}

/** Asks first ("Auto-organize…" in the canvas menu), then auto-organizes. */
export async function confirmAutoOrganize(
  displayId: number,
  area: Rect,
  iconSize: IconSize
): Promise<void> {
  const count = looseItems(displayId).length
  if (count === 0) {
    useUiStore.getState().pushToast({
      id: 'auto-organize-empty',
      message: 'There are no loose icons on this display to organize.'
    })
    return
  }
  const ok = await useUiStore.getState().confirm({
    title: 'Auto-organize this desktop?',
    description: `${count} loose icon${count === 1 ? '' : 's'} go into groups by type: Apps, Files, Folders and Web links. No files move; delete a group to undo.`,
    confirmLabel: 'Auto-organize'
  })
  if (ok) autoOrganizeDisplay(displayId, area, iconSize)
}

/** "Sort loose icons": by name, column-first from the work area's top-left, around the groups. */
export function sortLooseIcons(displayId: number, area: Rect, iconSize: IconSize): void {
  const order = sortByName(looseItems(displayId)).map((item) => item.id)
  useLayoutStore.getState().arrangeLoose(displayId, order, area, looseCell(iconSize))
}

/** "Refresh desktop": main scans again; the result arrives as desktop:changed. */
export function refreshDesktop(): void {
  getBridge()
    .desktop.rescan()
    .catch((error: unknown) => {
      console.error('desktop: rescanning failed', error)
      useUiStore.getState().pushToast({
        id: 'rescan-failed',
        tone: 'error',
        message: 'Taskyard couldn’t refresh your desktop.'
      })
    })
}

/** Opens a Windows Settings page (`ms-settings:` only; main enforces it). */
export function openSettingsPage(url: string): void {
  getBridge()
    .app.openExternal(url)
    .catch((error: unknown) => console.error(`app: opening ${url} failed`, error))
}

export function quitApp(): void {
  getBridge()
    .app.quit()
    .catch((error: unknown) => console.error('app: quit failed', error))
}
