import { autoOrganize } from '@shared/auto-organize'
import { clampRect, localWorkArea, snapRect, snapValue } from '@shared/geometry'
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
import { isPrimaryDisplay } from './reconcile-sync'
import { sortByName } from './sort-items'

// Desktop-level actions of the canvas (its menu, the marquee, the empty-desktop hint).

/** Creates a group and opens its inline rename, like Explorer's "New folder". */
function createAndRename(displayId: number, rect: Rect, ids: string[] = []): string | null {
  const id = useLayoutStore.getState().createGroup(displayId, rect, ids)
  if (id !== null) useUiStore.getState().startRename({ kind: 'group', id })
  return id
}

/**
 * "New group here": a 280 × 200 group at the click point (on the grid when `grid` is the grid
 * step; null when grid snap is off), inside the work area.
 */
export function newGroupAt(
  displayId: number,
  point: Point,
  area: Rect,
  grid: number | null
): string | null {
  const at = grid === null ? point : { x: snapValue(point.x, grid), y: snapValue(point.y, grid) }
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
  grid: number | null,
  ids: string[]
): string | null {
  const snapped = grid === null ? marquee : snapRect(marquee, grid)
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

/**
 * Settings › Reset layout (Phase 11): asks first (it cannot be undone), then removes every group
 * on every display and lays all the icons out again on the primary display, sorted by name, like
 * new ones. No file moves. The primary display comes from main, so any window can do it.
 */
export async function confirmResetLayout(iconSize: IconSize): Promise<void> {
  const ok = await useUiStore.getState().confirm({
    title: 'Reset the layout?',
    description:
      'Every group is removed on every display, and all your icons go back to the main display, sorted by name. No files move or change. This can’t be undone.',
    confirmLabel: 'Reset layout',
    destructive: true
  })
  if (!ok) return
  try {
    const displays = await getBridge().display.list()
    const primary = displays.find(isPrimaryDisplay) ?? displays[0]
    if (!primary) throw new Error('main listed no displays')
    const items = Object.values(useItemsStore.getState().byId).map(({ id, path, name }) => ({
      id,
      path,
      name
    }))
    useLayoutStore.getState().resetLayout(items, {
      displayId: primary.id,
      area: localWorkArea(primary),
      cell: looseCell(iconSize)
    })
  } catch (error) {
    console.error('layout: resetting failed', error)
    useUiStore.getState().pushToast({
      id: 'reset-layout-failed',
      tone: 'error',
      message: 'Taskyard couldn’t reset the layout.'
    })
  }
}

/** Settings › Open data folder: settings, layout, tasks and logs in Explorer. */
export function openDataFolder(): void {
  getBridge()
    .app.openDataFolder()
    .then(
      (opened) => {
        if (opened) return
        useUiStore.getState().pushToast({
          id: 'data-folder-failed',
          tone: 'error',
          message: 'Windows couldn’t open the data folder.'
        })
      },
      (error: unknown) => console.error('app: opening the data folder failed', error)
    )
}
