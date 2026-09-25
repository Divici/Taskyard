import { useEffect, useRef, useState } from 'react'
import type { DesktopItem } from '@shared/schema'
import { copyPaths, openItems, renameItem, trashItems } from '../../lib/item-actions'
import { itemKeyAction, type Direction } from '../../lib/keyboard'
import { useItemsStore } from '../../stores/items'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import type { DesktopIconProps } from './DesktopIcon'
import { optionDomId } from './item-label'

export interface ItemListOptions {
  /** 'desktop' for the loose layer, the group id for a group (keeps DOM ids unique). */
  scope: string
  /** The list's items in display order. */
  items: readonly DesktopItem[]
  /** Where an arrow key goes from `current` (grid for groups, nearest icon for loose). */
  neighbor(ids: readonly string[], current: string | null, direction: Direction): string | null
}

export type ItemIconBindings = Pick<
  DesktopIconProps,
  | 'selected'
  | 'tabbable'
  | 'renaming'
  | 'scope'
  | 'onSelect'
  | 'onOpen'
  | 'onRenameCommit'
  | 'onRenameCancel'
  | 'renameError'
  | 'renameDraft'
>

export interface ItemListApi {
  /** Spread on the listbox: the keyboard (arrows, Enter, F2, Delete, Esc, Ctrl+A). */
  onKeyDown(event: React.KeyboardEvent<HTMLElement>): void
  /** Spread on each DesktopIcon: selection, roving focus, open, inline rename. */
  iconProps(item: DesktopItem): ItemIconBindings
}

function focusOption(scope: string, id: string): void {
  document.getElementById(optionDomId(scope, id))?.focus()
}

/** Opens the item menu of an option from the keyboard, below it, as a right-click there would. */
function openOptionMenu(scope: string, id: string): void {
  const option = document.getElementById(optionDomId(scope, id))
  if (!option) return
  const rect = option.getBoundingClientRect()
  option.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.bottom
    })
  )
}

/**
 * Selection and keyboard behaviour of one list of desktop icons (a group body or the loose
 * layer), Explorer-style: click selects, Ctrl+click toggles, Shift+click selects a range, and
 * the keys of `lib/keyboard.ts`. Selection lives in the ui store (one per window); focus is a
 * roving tab stop kept here.
 */
export function useItemList({ scope, items, neighbor }: ItemListOptions): ItemListApi {
  const selection = useUiStore((state) => state.selection)
  const renaming = useUiStore((state) => state.renaming)
  const showExtension = useSettingsStore((state) => state.settings.showExtensions)
  const [active, setActive] = useState<string | null>(null)
  /** After an inline rename closes, focus goes back to the item (its label is back). */
  const refocus = useRef<string | null>(null)

  const ids = items.map((item) => item.id)
  const tabStop = active !== null && ids.includes(active) ? active : (ids[0] ?? null)

  useEffect(() => {
    if (refocus.current === null || renaming !== null) return
    focusOption(scope, refocus.current)
    refocus.current = null
  })

  const selectedItems = (): DesktopItem[] => {
    const byId = useItemsStore.getState().byId
    return useUiStore
      .getState()
      .selection.map((id) => byId[id])
      .filter((item): item is DesktopItem => item !== undefined)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const ui = useUiStore.getState()
    // A keyboard drag owns the arrows, Space, Enter and Escape until it drops (Phase 8).
    if (ui.drag !== null) return
    const action = itemKeyAction(event)
    if (!action) return
    event.preventDefault()
    switch (action.type) {
      case 'move': {
        const next = neighbor(ids, tabStop, action.direction)
        if (next === null) return
        setActive(next)
        ui.select([next])
        focusOption(scope, next)
        return
      }
      case 'open':
        void openItems(selectedItems())
        return
      case 'rename': {
        const current = ui.selection
        const target = tabStop !== null && current.includes(tabStop) ? tabStop : current[0]
        const item = target === undefined ? undefined : items.find((i) => i.id === target)
        if (item && !item.readonly) ui.startRename({ kind: 'item', id: item.id })
        return
      }
      case 'trash':
        void trashItems(selectedItems())
        return
      case 'clear':
        ui.clearSelection()
        return
      case 'selectAll':
        ui.select(ids, tabStop)
        return
      case 'copyPath':
        void copyPaths(selectedItems())
        return
      case 'menu': {
        const target =
          tabStop !== null && ui.selection.includes(tabStop) ? tabStop : ui.selection[0]
        if (target !== undefined) openOptionMenu(scope, target)
        return
      }
    }
  }

  const iconProps = (item: DesktopItem): ItemIconBindings => {
    const renamingThis = renaming?.kind === 'item' && renaming.id === item.id
    return {
      scope,
      selected: selection.includes(item.id),
      tabbable: item.id === tabStop,
      renaming: renamingThis,
      renameError: renamingThis ? renaming.error : undefined,
      renameDraft: renamingThis ? renaming.draft : undefined,
      onSelect(event) {
        const ui = useUiStore.getState()
        if (event.ctrlKey || event.metaKey) ui.toggleSelect(item.id)
        else if (event.shiftKey) ui.selectRange(ids, item.id)
        else ui.select([item.id])
        setActive(item.id)
      },
      onOpen() {
        void openItems([item])
      },
      onRenameCommit(typed) {
        refocus.current = item.id
        useUiStore.getState().stopRename()
        void renameItem(item, typed, showExtension).then((outcome) => {
          // The name itself was the problem (it exists, or Windows refuses it): reopen the field
          // on it with the reason, unless something else is being renamed by now.
          if (outcome.status !== 'retry' || useUiStore.getState().renaming !== null) return
          refocus.current = null
          useUiStore
            .getState()
            .startRename({ kind: 'item', id: item.id, error: outcome.error, draft: typed })
        })
      },
      onRenameCancel() {
        refocus.current = item.id
        useUiStore.getState().stopRename()
      }
    }
  }

  return { onKeyDown, iconProps }
}
