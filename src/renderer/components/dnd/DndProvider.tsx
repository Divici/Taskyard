import {
  DndContext,
  DragOverlay,
  useSensor,
  useSensors,
  type Announcements,
  type ScreenReaderInstructions,
  type UniqueIdentifier
} from '@dnd-kit/core'
import { useEffect, useMemo } from 'react'
import type { DesktopItem } from '@shared/schema'
import { useItemsStore } from '../../stores/items'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import { displayName } from '../icon/item-label'
import { desktopCollision } from './collision'
import { DRAG_ACTIVATION_DISTANCE, type DropData } from './dnd-types'
import type { DropPlace } from './drop-actions'
import { DragOverlayPreview } from './DragOverlayPreview'
import {
  cancelActivePointerDrag,
  DesktopKeyboardSensor,
  DesktopPointerSensor,
  KEYBOARD_CODES
} from './sensors'
import { routeAnnouncements, routeDragEvents } from './drag-routing'
import { useDragOut } from './useDragOut'
import { useItemDrop } from './useItemDrop'

export type DndProviderProps = DropPlace & { children: React.ReactNode }

/** Above every group (their z-index is their stacking rank). */
const OVERLAY_Z = 10_000

const INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'To move this icon, press Space. Move it with the arrow keys, then press Space to drop it or Escape to cancel.'
}

/** What the live region says during a drag (names, not file ids). */
function announcements(displayId: number): Announcements {
  const nameOf = (id: UniqueIdentifier): string => {
    const item = useItemsStore.getState().byId[String(id)]
    return item ? displayName(item, false) : 'the icon'
  }
  const moving = (id: UniqueIdentifier): string => {
    const count = useUiStore.getState().drag?.ids.length ?? 1
    return count > 1 ? `${count} icons` : nameOf(id)
  }
  const place = (data: DropData | undefined): string => {
    if (data?.kind !== 'group') return 'the desktop'
    const group = useLayoutStore
      .getState()
      .layout.displays.find((entry) => entry.displayId === displayId)
      ?.groups.find((entry) => entry.id === data.groupId)
    return `group ${group?.title ?? ''}`.trim()
  }
  const icons: Announcements = {
    onDragStart: ({ active }) => `Picked up ${moving(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${moving(active.id)} over ${place(over.data.current as DropData)}.`
        : `${moving(active.id)} is not over a drop place.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${moving(active.id)} on ${place(over.data.current as DropData)}.`
        : `${moving(active.id)} was not moved.`,
    onDragCancel: ({ active }) => `Moving ${moving(active.id)} was cancelled.`
  }
  // Phase 10: to-do rows are named by their text (drag-routing.ts).
  return routeAnnouncements(icons)
}

/**
 * Drag and drop for one display's desktop (Phase 8; LOCKED Decision 8): dnd-kit with a pointer
 * sensor that needs 6 px of movement (clicks and double-clicks stay clicks), a keyboard sensor
 * (Space), collisions topmost-group-first, the stacked preview in a DragOverlay (rendered here,
 * at the canvas root, outside every `.glass` whose `contain: paint` would clip it), and drag-out
 * to other apps. Wrap the canvas in it; groups and the canvas drop zone register inside.
 */
export function DndProvider({
  displayId,
  area,
  cell,
  children
}: DndProviderProps): React.JSX.Element {
  const sensors = useSensors(
    useSensor(DesktopPointerSensor, {
      activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE }
    }),
    useSensor(DesktopKeyboardSensor, { keyboardCodes: KEYBOARD_CODES })
  )
  const itemHandlers = useItemDrop({ displayId, area, cell })
  // Phase 10: to-do rows are sortables in this same context; their drags are routed apart.
  const handlers = useMemo(() => routeDragEvents(itemHandlers), [itemHandlers])
  useDragOut()
  // A drag cut short by an unmount (the display went away) must not keep listening on the
  // document: its release would still drop, from a canvas that no longer exists.
  useEffect(() => () => void cancelActivePointerDrag(), [])

  const drag = useUiStore((state) => state.drag)
  const byId = useItemsStore((state) => state.byId)
  const iconSize = useSettingsStore((state) => state.settings.iconSize)
  const showExtension = useSettingsStore((state) => state.settings.showExtensions)
  const accessibility = useMemo(
    () => ({ announcements: announcements(displayId), screenReaderInstructions: INSTRUCTIONS }),
    [displayId]
  )

  const previewItems = useMemo(() => {
    if (!drag) return []
    const order = [drag.activeId, ...drag.ids.filter((id) => id !== drag.activeId)]
    return order.map((id) => byId[id]).filter((item): item is DesktopItem => item !== undefined)
  }, [drag, byId])

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={desktopCollision}
      // The desktop never scrolls; a group body would scroll under a drag leaving it.
      autoScroll={false}
      accessibility={accessibility}
      {...handlers}
    >
      {children}
      {/* Mounted only while dragging: an overlay whose children turn null keeps a copy of them
          until its (disabled) drop animation settles, which would leave the preview up for a
          moment after a drop or a hand-over to the OS drag. */}
      {drag && (
        <DragOverlay dropAnimation={null} zIndex={OVERLAY_Z} className="pointer-events-none">
          <DragOverlayPreview
            items={previewItems}
            iconSize={iconSize}
            showExtension={showExtension}
          />
        </DragOverlay>
      )}
    </DndContext>
  )
}
