import { GROUP_BODY_PADDING, groupCell, groupColumns, type IconSize } from '@shared/group-metrics'
import type { DesktopItem, Group } from '@shared/schema'
import { gridNeighbor } from '../../lib/keyboard'
import { EmptyState } from '../feedback/EmptyState'
import { DesktopIcon } from '../icon/DesktopIcon'
import { IconContextMenu } from '../icon/IconContextMenu'
import { useItemList } from '../icon/useItemList'
import { useUiStore } from '../../stores/ui'

/**
 * Where a drop would insert: a bar at the left edge of the cell at `index` (in a `manual` group).
 * In the scrolling grid, so it scrolls with the icons; inside the group's box (a `.glass` clips
 * anything outside it).
 */
function DropIndicator({
  index,
  columns,
  cellHeight
}: {
  index: number
  columns: number
  cellHeight: number
}): React.JSX.Element {
  const column = index % columns
  const row = Math.floor(index / columns)
  return (
    <span
      data-drop-indicator={index}
      aria-hidden="true"
      className="pointer-events-none absolute w-0.5 rounded-full bg-accent-1 shadow-[0_0_6px_var(--color-accent-1)]"
      style={{
        left: `calc(${GROUP_BODY_PADDING}px + (100% - ${2 * GROUP_BODY_PADDING}px) * ${column} / ${columns} - 1px)`,
        top: GROUP_BODY_PADDING + row * cellHeight + 4,
        height: cellHeight - 8
      }}
    />
  )
}

export interface GroupBodyProps {
  group: Pick<Group, 'id' | 'title'>
  /** The display the group is on (its icons' menus act there). */
  displayId: number
  /** The members that are on the desktop now, in display order (sorted by the group's sort). */
  items: readonly DesktopItem[]
  /** The group's current width (live while resizing): sets the number of columns. */
  width: number
  iconSize: IconSize
  showExtension: boolean
  /** Phase 8: the rendered grid, where drops read their insert index from. */
  bodyRef?: React.Ref<HTMLDivElement>
}

/**
 * The icon grid of a group: a multi-select listbox, `cell` 64/80/96 px by icon size, as many
 * columns as fit the width, scrolling vertically. Empty groups invite a drop. Phase 8 attaches
 * its droppable to the element with `data-group-body`.
 */
export function GroupBody({
  group,
  displayId,
  items,
  width,
  iconSize,
  showExtension,
  bodyRef
}: GroupBodyProps): React.JSX.Element {
  const cell = groupCell(iconSize)
  const columns = groupColumns(width, cell)
  const insertAt = useUiStore((state) =>
    state.dropHint?.kind === 'group' && state.dropHint.groupId === group.id
      ? state.dropHint.index
      : null
  )
  // Drops read the grid from the DOM (src/renderer/components/dnd/group-drop.ts).
  const grid = {
    'data-group-body': group.id,
    'data-columns': columns,
    'data-cell-height': cell.height
  }
  const list = useItemList({
    scope: group.id,
    items,
    neighbor: (ids, current, direction) => gridNeighbor(ids, current, direction, columns)
  })

  if (items.length === 0) {
    return (
      <div ref={bodyRef} {...grid} className="flex min-h-0 flex-1 items-center justify-center">
        <EmptyState title="Drop icons here" />
      </div>
    )
  }

  return (
    <div
      ref={bodyRef}
      {...grid}
      role="listbox"
      aria-label={`${group.title} items`}
      aria-multiselectable="true"
      onKeyDown={list.onKeyDown}
      className="scrollbar-thin relative grid min-h-0 flex-1 content-start overflow-x-hidden overflow-y-auto"
      style={{
        padding: GROUP_BODY_PADDING,
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridAutoRows: cell.height
      }}
    >
      {items.map((item) => (
        <IconContextMenu key={item.id} item={item} displayId={displayId} groupId={group.id}>
          <DesktopIcon
            item={item}
            variant="group"
            iconSize={iconSize}
            showExtension={showExtension}
            {...list.iconProps(item)}
          />
        </IconContextMenu>
      ))}
      {insertAt !== null && (
        <DropIndicator index={insertAt} columns={columns} cellHeight={cell.height} />
      )}
    </div>
  )
}
