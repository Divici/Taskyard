import { useState } from 'react'
import { localWorkArea } from '@shared/geometry'
import { looseCell } from '@shared/group-metrics'
import type { DesktopItem } from '@shared/schema'
import { copyPaths, openItems, showItemInFolder, trashItems } from '../../lib/item-actions'
import { itemMenuTargetsFor, showItemShellMenu } from '../../lib/item-shell-menu'
import { removeFromGroup } from '../../lib/remove-from-group'
import { useDisplayStore } from '../../stores/display'
import { useItemsStore } from '../../stores/items'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '../ui/context-menu'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR, MENU_SHORTCUT } from '../menu/menu-styles'
import { useNativeFirstMenu, type NativeMenuHandler } from '../menu/useNativeFirstMenu'

export interface IconContextMenuProps {
  item: DesktopItem
  displayId: number
  /** The group the icon sits in ("Remove from group"), or null for a loose icon. */
  groupId: string | null
  /** The icon (a DesktopIcon): the menu's trigger. */
  children: React.ReactElement
}

/**
 * The selection a right-click acts on, Explorer-style: the whole selection when the clicked icon
 * is part of it, otherwise just that icon (which becomes the selection).
 */
function targetsFor(item: DesktopItem): string[] {
  const ui = useUiStore.getState()
  if (ui.selection.includes(item.id)) return [...ui.selection]
  ui.select([item.id])
  return [item.id]
}

function itemsOf(ids: readonly string[]): DesktopItem[] {
  const byId = useItemsStore.getState().byId
  return ids.map((id) => byId[id]).filter((item): item is DesktopItem => item !== undefined)
}

/**
 * Right-click menu of a desktop icon: Open · Open file location · Rename · Copy path · Remove from
 * group (in a group) · Delete. Rename and Delete are disabled for read-only items (Public
 * Desktop for a standard user); Rename also when several items are selected.
 *
 * With native menus (Phase 4) it is the fallback: a right-click (or Shift+F10 / the menu key)
 * shows Windows' own file menu for the icon — or the selection, when it shares one folder — and
 * this menu opens at the same point only when the native one could not show.
 */
export function IconContextMenu({
  item,
  displayId,
  groupId,
  children
}: IconContextMenuProps): React.JSX.Element {
  const [targets, setTargets] = useState<string[]>([item.id])
  const items = (): DesktopItem[] => {
    const found = itemsOf(targets)
    return found.length > 0 ? found : [item]
  }
  const several = targets.length > 1
  const allReadOnly = itemsOf(targets).every((target) => target.readonly)

  const nativeMenus = useUiStore((state) => state.nativeMenus)

  const remove = (ids: readonly string[]): void => {
    const info = useDisplayStore.getState().info
    if (groupId === null || info === null) return
    const cell = looseCell(useSettingsStore.getState().settings.iconSize)
    removeFromGroup(displayId, groupId, ids, localWorkArea(info), cell)
  }

  // Native menus (Phase 4): Windows' file menu for the targets; Taskyard's items and Windows'
  // Rename (intercepted) run here. The icon is selected first when it was not.
  const onNativeMenu: NativeMenuHandler | undefined = nativeMenus
    ? ({ point, shiftKey }) => {
        const ids = itemMenuTargetsFor(item)
        return showItemShellMenu(
          {
            displayId,
            point,
            shiftKey,
            ids,
            state: { inGroup: groupId !== null, canRename: ids.length === 1 && !item.readonly }
          },
          {
            removeFromGroup: () => remove(ids),
            copyPath: () => void copyPaths(itemsOf(ids)),
            rename: () => {
              if (!item.readonly) useUiStore.getState().startRename({ kind: 'item', id: item.id })
            }
          }
        )
      }
    : undefined
  const nativeFirst = useNativeFirstMenu(onNativeMenu)

  return (
    <ContextMenu
      // Not modal: Rename moves focus into the icon's field as the menu closes.
      modal={false}
      onOpenChange={(open) => {
        if (open) setTargets(targetsFor(item))
      }}
    >
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          // The icon's menu, not its group's (the group's trigger wraps this one).
          event.stopPropagation()
          nativeFirst(event)
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        className={MENU_CONTENT}
        // The desktop has nothing to return focus to; this also keeps the rename field focused.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ContextMenuItem
          className={`${MENU_ITEM} font-semibold`}
          onSelect={() => void openItems(items())}
        >
          Open
        </ContextMenuItem>
        <ContextMenuItem className={MENU_ITEM} onSelect={() => void showItemInFolder(item)}>
          Open file location
        </ContextMenuItem>
        <ContextMenuSeparator className={MENU_SEPARATOR} />
        <ContextMenuItem
          className={MENU_ITEM}
          disabled={several || item.readonly}
          onSelect={() => useUiStore.getState().startRename({ kind: 'item', id: item.id })}
        >
          Rename
          <ContextMenuShortcut className={MENU_SHORTCUT}>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem className={MENU_ITEM} onSelect={() => void copyPaths(items())}>
          Copy path
          <ContextMenuShortcut className={MENU_SHORTCUT}>Ctrl+Shift+C</ContextMenuShortcut>
        </ContextMenuItem>
        {groupId !== null && (
          <ContextMenuItem className={MENU_ITEM} onSelect={() => remove(targets)}>
            Remove from group
          </ContextMenuItem>
        )}
        <ContextMenuSeparator className={MENU_SEPARATOR} />
        <ContextMenuItem
          variant="destructive"
          className={MENU_ITEM}
          disabled={allReadOnly}
          onSelect={() => void trashItems(items())}
        >
          Delete
          <ContextMenuShortcut className={MENU_SHORTCUT}>Del</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
