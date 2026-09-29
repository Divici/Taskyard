import { useRef } from 'react'
import type { Point } from '@shared/schema'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'
import { MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR } from '../menu/menu-styles'

export const DISPLAY_SETTINGS_URL = 'ms-settings:display'
export const PERSONALIZE_URL = 'ms-settings:personalization-background'

export interface CanvasContextMenuProps {
  onNewGroup(point: Point): void
  onAutoOrganize(): void
  onSortLoose(): void
  onRefresh(): void
  onSettings(): void
  onOpenSettingsPage(url: string): void
  onQuit(): void
  /** Phase 10: whether the tools widget shows on this display (the item's wording). */
  toolsShown?: boolean
  /** Phase 10: "Show/Hide tools widget" (R9). */
  onToggleTools?(): void
  /**
   * Native menus (Phase 3): shows the real Windows desktop menu instead of this one. Resolves
   * false when it could not (this menu then opens at the same point). Omitted: this menu only.
   */
  onNativeMenu?(at: { point: Point; shiftKey: boolean }): Promise<boolean>
  /** The canvas surface (the trigger). */
  children: React.ReactElement
}

/**
 * The desktop's right-click menu: New group here · Auto-organize… · Sort loose icons · Refresh
 * desktop · Settings · Display settings · Personalize · Quit, plus Show/Hide tools widget after
 * Sort loose icons (Phase 10). With native menus (Phase 3) it is the fallback: a right-click
 * (or Shift+F10 / the menu key) goes to `onNativeMenu` first, and this menu opens at the same
 * point only when the native one could not show.
 */
export function CanvasContextMenu({
  onNewGroup,
  onAutoOrganize,
  onSortLoose,
  onRefresh,
  onSettings,
  onOpenSettingsPage,
  onQuit,
  toolsShown = false,
  onToggleTools,
  onNativeMenu,
  children
}: CanvasContextMenuProps): React.JSX.Element {
  const clickedAt = useRef<Point>({ x: 0, y: 0 })
  /** The next contextmenu is the fallback this component re-dispatches: let Radix open it. */
  const fallbackNext = useRef(false)

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          clickedAt.current = { x: event.clientX, y: event.clientY }
          if (fallbackNext.current) {
            fallbackNext.current = false
            return
          }
          if (!onNativeMenu) return
          // No Radix menu now: the native one shows, or this one follows as the fallback.
          event.preventDefault()
          const trigger = event.currentTarget
          const init: MouseEventInit = {
            bubbles: true,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY
          }
          void onNativeMenu({ point: { ...clickedAt.current }, shiftKey: event.shiftKey }).then(
            (handled) => {
              if (handled || !trigger.isConnected) return
              fallbackNext.current = true
              trigger.dispatchEvent(new MouseEvent('contextmenu', init))
            }
          )
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        className={MENU_CONTENT}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ContextMenuItem className={MENU_ITEM} onSelect={() => onNewGroup(clickedAt.current)}>
          New group here
        </ContextMenuItem>
        <ContextMenuItem className={MENU_ITEM} onSelect={onAutoOrganize}>
          Auto-organize…
        </ContextMenuItem>
        <ContextMenuItem className={MENU_ITEM} onSelect={onSortLoose}>
          Sort loose icons
        </ContextMenuItem>
        {onToggleTools && (
          <ContextMenuItem className={MENU_ITEM} onSelect={onToggleTools}>
            {toolsShown ? 'Hide tools widget' : 'Show tools widget'}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator className={MENU_SEPARATOR} />
        <ContextMenuItem className={MENU_ITEM} onSelect={onRefresh}>
          Refresh desktop
        </ContextMenuItem>
        <ContextMenuSeparator className={MENU_SEPARATOR} />
        <ContextMenuItem className={MENU_ITEM} onSelect={onSettings}>
          Settings
        </ContextMenuItem>
        <ContextMenuItem
          className={MENU_ITEM}
          onSelect={() => onOpenSettingsPage(DISPLAY_SETTINGS_URL)}
        >
          Display settings
        </ContextMenuItem>
        <ContextMenuItem className={MENU_ITEM} onSelect={() => onOpenSettingsPage(PERSONALIZE_URL)}>
          Personalize
        </ContextMenuItem>
        <ContextMenuSeparator className={MENU_SEPARATOR} />
        <ContextMenuItem className={MENU_ITEM} onSelect={onQuit}>
          Quit
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
