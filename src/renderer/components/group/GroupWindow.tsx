import { useMemo, useRef, useState } from 'react'
import { GROUP_HEADER_HEIGHT, GROUP_MIN_SIZE } from '@shared/group-metrics'
import type { DesktopItem, Group, Rect } from '@shared/schema'
import { sortItems } from '../../lib/sort-items'
import { cn } from '../../lib/utils'
import { useItemsStore } from '../../stores/items'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import { GroupBody } from './GroupBody'
import { GroupContextMenu } from './GroupContextMenu'
import { GroupHeader } from './GroupHeader'
import { ResizeHandles } from './ResizeHandles'
import { useGroupDrag } from './useGroupDrag'

export interface GroupWindowProps {
  group: Group
  displayId: number
  /** The display's work area in window coordinates: edges never leave it. */
  area: Rect
  /** CSS stacking order among the groups (their rank by `z`); defaults to `z`. */
  stackIndex?: number
  /** Quick-hide: faded out and inert (unless the group is excluded). */
  hidden?: boolean
}

const groupRect = (group: Group): Rect => ({
  x: group.x,
  y: group.y,
  width: group.w,
  height: group.h
})

/**
 * One group ("fence"): a glass region at its rect with a draggable title bar, 8 resize handles
 * and the icon grid; rolled up it is just its 36 px header, keeping its width. Moves and resizes
 * preview locally and save once, on release.
 */
export function GroupWindow({
  group,
  displayId,
  area,
  stackIndex,
  hidden = false
}: GroupWindowProps): React.JSX.Element {
  const iconSize = useSettingsStore((state) => state.settings.iconSize)
  const showExtension = useSettingsStore((state) => state.settings.showExtensions)
  const snap = useSettingsStore((state) => state.settings.gridSnap)
  const byId = useItemsStore((state) => state.byId)
  const renaming = useUiStore(
    (state) => state.renaming?.kind === 'group' && state.renaming.id === group.id
  )
  const [draft, setDraft] = useState<Rect | null>(null)
  const [resizing, setResizing] = useState(false)
  const element = useRef<HTMLElement>(null)

  const layout = (): ReturnType<typeof useLayoutStore.getState> => useLayoutStore.getState()
  const rect = draft ?? groupRect(group)

  const items = useMemo(
    () =>
      sortItems(
        group.items.map((id) => byId[id]).filter((item): item is DesktopItem => !!item),
        group.sort
      ),
    [group.items, group.sort, byId]
  )

  const drag = useGroupDrag({
    rect: groupRect(group),
    area,
    snap,
    onDrag: setDraft,
    onDragEnd(final) {
      setDraft(null)
      layout().moveGroup(displayId, group.id, { x: final.x, y: final.y })
    }
  })

  const openMenu = (anchor: DOMRect): void => {
    // The menu is a context menu: open it where the "…" button is, as a right-click would.
    element.current?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: anchor.left,
        clientY: anchor.bottom
      })
    )
  }

  return (
    <GroupContextMenu group={group} displayId={displayId} area={area} itemCount={items.length}>
      <section
        ref={element}
        role="region"
        aria-label={group.title}
        aria-hidden={hidden || undefined}
        inert={hidden}
        data-group-id={group.id}
        data-rolled-up={group.rolledUp || undefined}
        data-dragging={drag.dragging || resizing || undefined}
        // Any press on the group raises it (a no-op when it is already on top).
        onPointerDownCapture={() => layout().bringGroupToFront(displayId, group.id)}
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: group.rolledUp ? GROUP_HEADER_HEIGHT : rect.height,
          zIndex: stackIndex ?? group.z
        }}
        className={cn(
          'glass absolute flex flex-col transition-[opacity,border-color] duration-[180ms] hover:border-accent-1/50',
          hidden && 'pointer-events-none opacity-0'
        )}
      >
        <GroupHeader
          title={group.title}
          rolledUp={group.rolledUp}
          renaming={renaming}
          drag={drag.handlers}
          dragging={drag.dragging}
          onToggleRollUp={() => layout().toggleRollUp(displayId, group.id)}
          onOpenMenu={openMenu}
          onRename={() => useUiStore.getState().startRename({ kind: 'group', id: group.id })}
          onRenameCommit={(title) => {
            useUiStore.getState().stopRename()
            layout().renameGroup(displayId, group.id, title)
          }}
          onRenameCancel={() => useUiStore.getState().stopRename()}
        />
        {!group.rolledUp && (
          <GroupBody
            group={group}
            items={items}
            width={rect.width}
            iconSize={iconSize}
            showExtension={showExtension}
          />
        )}
        <ResizeHandles
          rect={groupRect(group)}
          area={area}
          min={GROUP_MIN_SIZE}
          snap={snap}
          rolledUp={group.rolledUp}
          onResizeStart={() => setResizing(true)}
          onResize={setDraft}
          onResizeEnd={(final) => {
            setResizing(false)
            setDraft(null)
            layout().resizeGroup(displayId, group.id, final)
          }}
        />
      </section>
    </GroupContextMenu>
  )
}
