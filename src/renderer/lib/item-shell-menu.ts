import type { ShellMenuShowResult } from '@shared/ipc'
import type { DesktopItem, Point } from '@shared/schema'
import { ITEM_MENU_IDS, itemMenuTargets, type ItemMenuState } from '@shared/shell-menu'
import { useItemsStore } from '../stores/items'
import { useUiStore } from '../stores/ui'
import { askShellMenu, toastFailedCommand } from './shell-menu'

// Native menus, Phase 4: a right-click (or Shift+F10 / the menu key) on desktop icons shows the
// real Windows file menu for them — Open, Open with, Send to, Cut, Copy, Create shortcut, Delete,
// Properties and the shell extensions all run in Windows, and the watcher reflects what they do.
// Taskyard adds "Remove from group" and (where Windows has no "Copy as path") "Copy path", and
// Windows' Rename opens Taskyard's inline rename. If the native menu cannot show, the icon opens
// Taskyard's own menu (IconContextMenu) at the same point.

/** What an icon menu's Taskyard items (and the intercepted Rename) do for its targets. */
export interface ItemMenuActions {
  removeFromGroup(): void
  copyPath(): void
  /** Windows' Rename: Taskyard's inline rename of the right-clicked icon. */
  rename(): void
}

/**
 * The items a right-click on `item` acts on, Explorer-style (`itemMenuTargets`): an icon outside
 * the selection is selected first; a selection holding it counts whole when it shares one folder,
 * else the icon alone. The right-clicked id comes first.
 */
export function itemMenuTargetsFor(item: DesktopItem): string[] {
  const ui = useUiStore.getState()
  if (!ui.selection.includes(item.id)) ui.select([item.id])
  const byId = useItemsStore.getState().byId
  return itemMenuTargets(item.id, useUiStore.getState().selection, (id) => byId[id]?.path)
}

/** Runs what the user chose in an icon's native menu. */
export function routeItemMenuResult(result: ShellMenuShowResult, actions: ItemMenuActions): void {
  if (result.kind === 'invoke-failed') return toastFailedCommand(result)
  if (result.kind === 'intercepted') {
    if (result.verb === 'rename') actions.rename()
    return
  }
  if (result.kind !== 'taskyard') return
  switch (result.id) {
    case ITEM_MENU_IDS.removeFromGroup:
      return actions.removeFromGroup()
    case ITEM_MENU_IDS.copyPath:
      return actions.copyPath()
    default:
      console.warn(`shell-menu: no action for the icon menu id "${result.id}"`)
  }
}

export interface ItemMenuRequest {
  displayId: number
  /** Where it was right-clicked (or below the focused icon, from the keyboard), window CSS px. */
  point: Point
  shiftKey: boolean
  /** The targets, right-clicked first (`itemMenuTargetsFor`). */
  ids: string[]
  state: ItemMenuState
}

/**
 * Shows the native file menu for the icons and runs the choice. Resolves true when the native
 * menu handled the right-click, false when Taskyard's own icon menu must open instead.
 */
export async function showItemShellMenu(
  request: ItemMenuRequest,
  actions: ItemMenuActions
): Promise<boolean> {
  const result = await askShellMenu({
    kind: 'items',
    displayId: request.displayId,
    point: { ...request.point },
    extendedVerbs: request.shiftKey,
    ids: [...request.ids],
    state: { ...request.state }
  })
  if (result === null) return false
  routeItemMenuResult(result, actions)
  return true
}
