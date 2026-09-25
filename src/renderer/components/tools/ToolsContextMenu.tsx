import { useLayoutStore } from '../../stores/layout'
import { useTasksStore } from '../../stores/tasks'
import { MENU_CHECK_ITEM, MENU_CONTENT, MENU_ITEM, MENU_SEPARATOR } from '../menu/menu-styles'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'
import { patchTools, TOOL_IDS, TOOL_LABELS, type ToolId } from './tools-geometry'

export interface ToolsContextMenuProps {
  displayId: number
  activeTool: ToolId
  rolledUp: boolean
  /** The widget element (the menu's trigger). */
  children: React.ReactElement
}

/**
 * Right-click (or "…") menu of the tools widget: switch tool · Roll up/down · Clear completed
 * tasks · Hide tools widget (the desktop menu shows it again).
 */
export function ToolsContextMenu({
  displayId,
  activeTool,
  rolledUp,
  children
}: ToolsContextMenuProps): React.JSX.Element {
  const tools = (patch: Parameters<typeof patchTools>[0]): void =>
    useLayoutStore.getState().updateTools(displayId, patchTools(patch))
  const hasCompleted = useTasksStore((state) => state.tasks.some((task) => task.done))

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        className={MENU_CONTENT}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ContextMenuRadioGroup
          value={activeTool}
          onValueChange={(value) => tools({ activeTool: value as ToolId })}
        >
          {TOOL_IDS.map((tool) => (
            <ContextMenuRadioItem key={tool} value={tool} className={MENU_CHECK_ITEM}>
              {TOOL_LABELS[tool]}
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
        <ContextMenuSeparator className={MENU_SEPARATOR} />
        <ContextMenuItem className={MENU_ITEM} onSelect={() => tools({ rolledUp: !rolledUp })}>
          {rolledUp ? 'Roll down' : 'Roll up'}
        </ContextMenuItem>
        <ContextMenuItem
          className={MENU_ITEM}
          disabled={!hasCompleted}
          onSelect={() => useTasksStore.getState().clearCompleted()}
        >
          Clear completed tasks
        </ContextMenuItem>
        <ContextMenuSeparator className={MENU_SEPARATOR} />
        <ContextMenuItem className={MENU_ITEM} onSelect={() => tools({ visible: false })}>
          Hide tools widget
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
