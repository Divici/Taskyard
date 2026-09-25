import { useState } from 'react'
import { localWorkArea } from '@shared/geometry'
import { looseCell } from '@shared/group-metrics'
import type { DisplayInfo } from '@shared/ipc'
import { nearRectSlots } from '@shared/placement'
import type { Group, GroupSort, Rect, SettingsFile } from '@shared/schema'
import { getBridge } from '../../lib/bridge'
import { clampGroupInto, useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '../ui/context-menu'
import {
  MENU_CHECK_ITEM,
  MENU_CONTENT,
  MENU_ITEM,
  MENU_SEPARATOR,
  MENU_SHORTCUT
} from '../menu/menu-styles'

const SORTS: ReadonlyArray<[GroupSort, string]> = [
  ['manual', 'Manual'],
  ['name', 'Name'],
  ['type', 'Type'],
  ['modified', 'Date modified']
]

const ICON_SIZES: ReadonlyArray<[SettingsFile['iconSize'], string]> = [
  ['small', 'Small'],
  ['medium', 'Medium'],
  ['large', 'Large']
]

export interface GroupContextMenuProps {
  group: Group
  displayId: number
  /** This display's work area (where a deleted group's items land). */
  area: Rect
  /** How many of its items are on the desktop now (the delete confirm says so). */
  itemCount: number
  /** The group element (the menu's trigger). */
  children: React.ReactElement
}

function deleteGroupDescription(count: number): string {
  if (count === 0) return 'It’s empty. No files are deleted.'
  return count === 1
    ? 'Its 1 item goes back to the desktop. No files are deleted.'
    : `Its ${count} items go back to the desktop. No files are deleted.`
}

function displayLabel(info: DisplayInfo, index: number): string {
  return `Display ${index + 1} (${info.bounds.width} × ${info.bounds.height})`
}

/**
 * Right-click menu of a group: Rename · Roll up/down · Sort by ▸ · Icon size ▸ · Exclude from
 * quick-hide · Move to display ▸ · Delete group (asks first; files are never deleted).
 */
export function GroupContextMenu({
  group,
  displayId,
  area,
  itemCount,
  children
}: GroupContextMenuProps): React.JSX.Element {
  const iconSize = useSettingsStore((state) => state.settings.iconSize)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const layout = (): ReturnType<typeof useLayoutStore.getState> => useLayoutStore.getState()

  const loadDisplays = (): void => {
    getBridge()
      .display.list()
      .then(setDisplays, (error: unknown) => {
        console.error('display: listing the displays failed', error)
        setDisplays([])
      })
  }

  const deleteGroup = async (): Promise<void> => {
    const ok = await useUiStore.getState().confirm({
      title: `Delete group “${group.title}”?`,
      description: deleteGroupDescription(itemCount),
      confirmLabel: 'Delete group',
      destructive: true
    })
    if (ok) layout().deleteGroup(displayId, group.id, nearRectSlots(area, looseCell(iconSize)))
  }

  const others = displays
    .map((info, index) => ({ info, label: displayLabel(info, index) }))
    .filter(({ info }) => info.id !== displayId)

  return (
    <ContextMenu
      // Not modal: its actions move focus out of the menu (rename fields) as it closes.
      modal={false}
      onOpenChange={(open) => {
        if (open) loadDisplays()
      }}
    >
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        className={MENU_CONTENT}
        // The desktop has nothing to return focus to; this also keeps the rename field focused.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ContextMenuItem
          className={MENU_ITEM}
          onSelect={() => useUiStore.getState().startRename({ kind: 'group', id: group.id })}
        >
          Rename
          <ContextMenuShortcut className={MENU_SHORTCUT}>F2</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          className={MENU_ITEM}
          onSelect={() => layout().toggleRollUp(displayId, group.id)}
        >
          {group.rolledUp ? 'Roll down' : 'Roll up'}
        </ContextMenuItem>
        <ContextMenuSeparator className={MENU_SEPARATOR} />
        <ContextMenuSub>
          <ContextMenuSubTrigger className={MENU_ITEM}>Sort by</ContextMenuSubTrigger>
          <ContextMenuSubContent className={MENU_CONTENT}>
            <ContextMenuRadioGroup
              value={group.sort}
              onValueChange={(value) =>
                layout().setGroupSort(displayId, group.id, value as GroupSort)
              }
            >
              {SORTS.map(([value, label]) => (
                <ContextMenuRadioItem key={value} value={value} className={MENU_CHECK_ITEM}>
                  {label}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger className={MENU_ITEM}>Icon size</ContextMenuSubTrigger>
          <ContextMenuSubContent className={MENU_CONTENT}>
            <ContextMenuRadioGroup
              value={iconSize}
              onValueChange={(value) =>
                useSettingsStore.getState().update({ iconSize: value as SettingsFile['iconSize'] })
              }
            >
              {ICON_SIZES.map(([value, label]) => (
                <ContextMenuRadioItem key={value} value={value} className={MENU_CHECK_ITEM}>
                  {label}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuCheckboxItem
          className={MENU_CHECK_ITEM}
          checked={group.excludeFromQuickHide}
          onCheckedChange={(checked) =>
            layout().setExcludeFromQuickHide(displayId, group.id, checked === true)
          }
        >
          Exclude from quick-hide
        </ContextMenuCheckboxItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger className={MENU_ITEM}>Move to display</ContextMenuSubTrigger>
          <ContextMenuSubContent className={MENU_CONTENT}>
            {others.length === 0 ? (
              <ContextMenuItem className={MENU_ITEM} disabled>
                No other display
              </ContextMenuItem>
            ) : (
              others.map(({ info, label }) => (
                <ContextMenuItem
                  key={info.id}
                  className={MENU_ITEM}
                  onSelect={() =>
                    layout().moveGroupToDisplay(
                      displayId,
                      group.id,
                      info.id,
                      clampGroupInto(localWorkArea(info))
                    )
                  }
                >
                  {label}
                </ContextMenuItem>
              ))
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator className={MENU_SEPARATOR} />
        <ContextMenuItem
          variant="destructive"
          className={MENU_ITEM}
          onSelect={() => void deleteGroup()}
        >
          Delete group
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
