import { localWorkArea } from '@shared/geometry'
import { looseCell, type IconSize } from '@shared/group-metrics'
import { cellAt, looseDropPositions } from '@shared/drop-placement'
import type { NewItemPlacement, ShellMenuShowResult } from '@shared/ipc'
import type { Point } from '@shared/schema'
import {
  CANVAS_MENU_IDS,
  ICON_SIZE_BY_ID,
  SORT_KEY_BY_ID,
  type CanvasMenuState,
  type LooseSortKey
} from '@shared/shell-menu'
import type { TaskyardApi } from '../../preload/api'
import { useDisplayStore } from '../stores/display'
import { useLayoutStore } from '../stores/layout'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { getBridge } from './bridge'

// Native menus, Phase 3: the empty desktop's right-click shows the real Windows desktop menu
// (main's shell-menu helper), with Taskyard's items in a "Taskyard ▸" submenu and View ▸ /
// Sort by ▸ mapped to Taskyard. This module asks main for it, runs what was chosen, and places
// the items New ▸ / Paste made at the right-click point. If the native menu cannot show,
// the canvas opens Taskyard's own menu (CanvasContextMenu) at the same point.

/** What the native desktop menu's Taskyard items do on one display (DesktopCanvas binds them). */
export interface CanvasMenuActions {
  /** "New group here" at the right-click point (window CSS px). */
  newGroup(point: Point): void
  autoOrganize(): void
  sortLoose(key: LooseSortKey): void
  toggleTools(): void
  /** Refresh desktop (Taskyard ▸) and Windows' own Refresh. */
  refresh(): void
  openSettings(): void
  quit(): void
  setIconSize(size: IconSize): void
  toggleGridSnap(): void
  /** View ▸ Show desktop icons. */
  toggleQuickHide(): void
}

/** What the menu's ticks and wording depend on, read from this window's stores. */
export function canvasMenuState(toolsShown: boolean): CanvasMenuState {
  const { iconSize, gridSnap } = useSettingsStore.getState().settings
  return { iconSize, gridSnap, quickHidden: useUiStore.getState().quickHidden, toolsShown }
}

/** Runs what the user chose in the native desktop menu (`point`: where it was opened). */
export function routeCanvasMenuResult(
  result: ShellMenuShowResult,
  point: Point,
  actions: CanvasMenuActions
): void {
  if (result.kind === 'intercepted') {
    // Windows' Refresh would only refresh the invisible shell view: Taskyard rescans instead.
    if (result.verb === 'refresh') actions.refresh()
    return
  }
  if (result.kind === 'invoke-failed') {
    useUiStore.getState().pushToast({
      id: 'shell-menu-failed',
      tone: 'error',
      message: `Windows couldn’t complete “${result.label || 'that command'}”.`,
      description: result.message
    })
    return
  }
  if (result.kind !== 'taskyard') return
  const { id } = result
  const size = ICON_SIZE_BY_ID[id]
  if (size) return actions.setIconSize(size)
  const sort = SORT_KEY_BY_ID[id]
  if (sort) return actions.sortLoose(sort)
  switch (id) {
    case CANVAS_MENU_IDS.newGroup:
      return actions.newGroup({ ...point })
    case CANVAS_MENU_IDS.autoOrganize:
      return actions.autoOrganize()
    case CANVAS_MENU_IDS.sortLoose:
      return actions.sortLoose('name')
    case CANVAS_MENU_IDS.toggleTools:
      return actions.toggleTools()
    case CANVAS_MENU_IDS.refresh:
      return actions.refresh()
    case CANVAS_MENU_IDS.settings:
      return actions.openSettings()
    case CANVAS_MENU_IDS.quit:
      return actions.quit()
    case CANVAS_MENU_IDS.gridSnap:
      return actions.toggleGridSnap()
    case CANVAS_MENU_IDS.showIcons:
      return actions.toggleQuickHide()
    default:
      console.warn(`shell-menu: no action for the menu id "${id}"`)
  }
}

export interface CanvasMenuRequest {
  displayId: number
  /** Where it was right-clicked (or the focused element, from the keyboard), window CSS px. */
  point: Point
  shiftKey: boolean
  toolsShown: boolean
}

/**
 * Shows the native desktop menu and runs the choice. Resolves true when the native menu handled
 * the right-click (whatever the user did in it), false when Taskyard's own menu must open
 * instead (no helper, it failed or timed out before showing, or main could not be asked).
 */
export async function showCanvasShellMenu(
  request: CanvasMenuRequest,
  actions: CanvasMenuActions
): Promise<boolean> {
  let result: ShellMenuShowResult
  try {
    result = await getBridge().shellMenu.show({
      kind: 'background',
      displayId: request.displayId,
      point: { ...request.point },
      extendedVerbs: request.shiftKey,
      state: canvasMenuState(request.toolsShown)
    })
  } catch (error) {
    console.error('shell-menu: asking main failed', error)
    return false
  }
  if (result.kind === 'fallback') return false
  routeCanvasMenuResult(result, request.point, actions)
  return true
}

/**
 * New ▸ / Paste items on this display: at the right-click cell (then the next free cells), like
 * an Explorer drop — moved off whatever cell the primary window's reconcile first gave them —
 * and a new folder or file opens its inline rename, as on the Windows desktop.
 */
export function placeNewItems(placement: NewItemPlacement): void {
  const info = useDisplayStore.getState().info
  if (!info || info.id !== placement.displayId || placement.ids.length === 0) return
  const store = useLayoutStore.getState()
  const display = store.layout.displays.find((entry) => entry.displayId === info.id)
  if (!display) return
  const area = localWorkArea(info)
  const cell = looseCell(useSettingsStore.getState().settings.iconSize)
  const positions = looseDropPositions({
    ids: placement.ids,
    activeId: placement.ids[0],
    anchor: cellAt(placement.point, cell, area),
    display,
    cell,
    area
  })
  store.placeItems(info.id, [...placement.ids], { loose: positions })
  if (placement.renameId !== null) {
    useUiStore.getState().startRename({ kind: 'item', id: placement.renameId })
  }
}

/**
 * Asks main whether native menus can show (else the canvas keeps Taskyard's menus), and places
 * New ▸ / Paste items that main tags for this display. Returns the disconnect.
 */
export function connectShellMenu(api: Pick<TaskyardApi, 'shellMenu' | 'on'>): () => void {
  let connected = true
  api.shellMenu.available().then(
    (available) => {
      if (connected) useUiStore.getState().setNativeMenus(available)
    },
    (error: unknown) =>
      console.error('shell-menu: asking main whether menus can show failed', error)
  )
  const off = api.on('desktop:changed', (change) => {
    if (change.placeAt) placeNewItems(change.placeAt)
  })
  return () => {
    connected = false
    off()
  }
}
