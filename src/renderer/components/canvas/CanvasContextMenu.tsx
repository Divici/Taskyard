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
  /** The canvas surface (the trigger). */
  children: React.ReactElement
}

/**
 * The desktop's right-click menu: New group here · Auto-organize… · Sort loose icons · Refresh
 * desktop · Settings · Display settings · Personalize · Quit. (Phase 10 adds Show/Hide tools
 * widget.)
 */
export function CanvasContextMenu({
  onNewGroup,
  onAutoOrganize,
  onSortLoose,
  onRefresh,
  onSettings,
  onOpenSettingsPage,
  onQuit,
  children
}: CanvasContextMenuProps): React.JSX.Element {
  const clickedAt = useRef<Point>({ x: 0, y: 0 })

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          clickedAt.current = { x: event.clientX, y: event.clientY }
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
