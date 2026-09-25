import { GROUP_BODY_PADDING, groupCell, groupColumns, type IconSize } from '@shared/group-metrics'
import type { DesktopItem, Group } from '@shared/schema'
import { gridNeighbor } from '../../lib/keyboard'
import { DesktopIcon } from '../icon/DesktopIcon'
import { useItemList } from '../icon/useItemList'

export interface GroupBodyProps {
  group: Pick<Group, 'id' | 'title'>
  /** The members that are on the desktop now, in display order (sorted by the group's sort). */
  items: readonly DesktopItem[]
  /** The group's current width (live while resizing): sets the number of columns. */
  width: number
  iconSize: IconSize
  showExtension: boolean
}

/**
 * The icon grid of a group: a multi-select listbox, `cell` 64/80/96 px by icon size, as many
 * columns as fit the width, scrolling vertically. Empty groups invite a drop. Phase 8 attaches
 * its droppable to the element with `data-group-body`.
 */
export function GroupBody({
  group,
  items,
  width,
  iconSize,
  showExtension
}: GroupBodyProps): React.JSX.Element {
  const cell = groupCell(iconSize)
  const columns = groupColumns(width, cell)
  const list = useItemList({
    scope: group.id,
    items,
    neighbor: (ids, current, direction) => gridNeighbor(ids, current, direction, columns)
  })

  if (items.length === 0) {
    return (
      <div
        data-group-body={group.id}
        className="flex min-h-0 flex-1 items-center justify-center p-3 text-center text-[11px] tracking-wide text-text-tertiary"
      >
        Drop icons here
      </div>
    )
  }

  return (
    <div
      data-group-body={group.id}
      role="listbox"
      aria-label={`${group.title} items`}
      aria-multiselectable="true"
      onKeyDown={list.onKeyDown}
      className="scrollbar-thin grid min-h-0 flex-1 content-start overflow-x-hidden overflow-y-auto"
      style={{
        padding: GROUP_BODY_PADDING,
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridAutoRows: cell.height
      }}
    >
      {items.map((item) => (
        <DesktopIcon
          key={item.id}
          item={item}
          variant="group"
          iconSize={iconSize}
          showExtension={showExtension}
          {...list.iconProps(item)}
        />
      ))}
    </div>
  )
}
