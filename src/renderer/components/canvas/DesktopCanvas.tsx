import { useEffect, useMemo } from 'react'
import { clampRect, localWorkArea } from '@shared/geometry'
import { looseCell } from '@shared/group-metrics'
import type { DisplayInfo } from '@shared/ipc'
import type { Group, Point } from '@shared/schema'
import {
  autoOrganizeDisplay,
  confirmAutoOrganize,
  groupFromMarquee,
  newGroupAt,
  openSettingsPage,
  quitApp,
  refreshDesktop,
  sortLooseIcons
} from '../../lib/canvas-actions'
import { useItemsStore } from '../../stores/items'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import { CanvasDropZone } from '../dnd/CanvasDropZone'
import { DndProvider } from '../dnd/DndProvider'
import { useExternalDrop } from '../dnd/useExternalDrop'
import { GroupWindow } from '../group/GroupWindow'
import { CanvasContextMenu } from './CanvasContextMenu'
import { EmptyHint } from './EmptyHint'
import { LooseIconLayer } from './LooseIconLayer'
import { Marquee } from './Marquee'
import { useMarquee } from './useMarquee'

export interface DesktopCanvasProps {
  displayId: number
  info: DisplayInfo
}

const NO_GROUPS: readonly Group[] = []
const NO_LOOSE: Readonly<Record<string, Point>> = {}

/** A group pulled back inside the work area (the same group when it already is). */
function clampedInto(area: ReturnType<typeof localWorkArea>): (group: Group) => Group {
  return (group) => {
    const rect = { x: group.x, y: group.y, width: group.w, height: group.h }
    const clamped = clampRect(rect, area)
    return clamped === rect
      ? group
      : { ...group, x: clamped.x, y: clamped.y, w: clamped.width, h: clamped.height }
  }
}

/**
 * One display's desktop, above the wallpaper: the empty surface (context menu, marquee,
 * double-click quick-hide), the loose icons, the groups stacked by `z`, and the empty-desktop
 * hint. Coordinates are the window's CSS pixels; the work area bounds every group.
 */
export function DesktopCanvas({ displayId, info }: DesktopCanvasProps): React.JSX.Element {
  const entry = useLayoutStore((state) =>
    state.layout.displays.find((display) => display.displayId === displayId)
  )
  const layoutHydrated = useLayoutStore((state) => state.hydrated)
  const byId = useItemsStore((state) => state.byId)
  const settings = useSettingsStore((state) => state.settings)
  const quickHidden = useUiStore((state) => state.quickHidden)
  const hintDismissed = useUiStore((state) => state.hintDismissed)

  const groups = entry?.groups ?? NO_GROUPS
  const loose = entry?.loose ?? NO_LOOSE
  const { x, y, width, height } = localWorkArea(info)
  const area = useMemo(() => ({ x, y, width, height }), [x, y, width, height])
  const cell = looseCell(settings.iconSize)

  const stacked = useMemo(() => [...groups].sort((a, b) => a.z - b.z), [groups])
  const looseTargets = useMemo(
    () =>
      Object.entries(loose)
        .filter(([id]) => byId[id] !== undefined)
        .map(([id, point]) => ({ id, rect: { ...point, ...cell } })),
    [loose, byId, cell]
  )

  // Soft clamp: whenever the work area changes (taskbar moved, resolution or DPI change), groups
  // that now stick out are pulled back in. Each window only edits its own display.
  useEffect(() => {
    if (!layoutHydrated) return
    const store = useLayoutStore.getState()
    const display = store.layout.displays.find((d) => d.displayId === displayId)
    for (const group of display?.groups ?? []) {
      store.updateGroup(displayId, group.id, clampedInto(area))
    }
  }, [area, displayId, layoutHydrated])

  const marquee = useMarquee({
    targets: looseTargets,
    onDrawGroup: (rect, ids) => groupFromMarquee(displayId, rect, area, settings.gridSnap, ids)
  })

  const showHint = !hintDismissed && groups.length === 0 && looseTargets.length > 0
  // Phase 8: files dropped from Explorer (native events; dnd-kit handles our own icons).
  const externalDrop = useExternalDrop({ displayId, area, cell })

  return (
    <div data-desktop-canvas={displayId} className="absolute inset-0" {...externalDrop}>
      <DndProvider displayId={displayId} area={area} cell={cell}>
        <CanvasContextMenu
          onNewGroup={(point) => newGroupAt(displayId, point, area, settings.gridSnap)}
          onAutoOrganize={() => void confirmAutoOrganize(displayId, area, settings.iconSize)}
          onSortLoose={() => sortLooseIcons(displayId, area, settings.iconSize)}
          onRefresh={refreshDesktop}
          onSettings={() => useUiStore.getState().setInspectorOpen(true)}
          onOpenSettingsPage={openSettingsPage}
          onQuit={quitApp}
        >
          <div
            data-canvas-surface=""
            className="absolute inset-0"
            {...marquee.handlers}
            onDoubleClick={() => {
              if (settings.quickHideOnDoubleClick) useUiStore.getState().toggleQuickHidden()
            }}
          />
        </CanvasContextMenu>
        <CanvasDropZone cell={cell} />
        <LooseIconLayer
          loose={loose}
          byId={byId}
          cell={cell}
          iconSize={settings.iconSize}
          showExtension={settings.showExtensions}
          hidden={quickHidden}
        />
        {stacked.map((group, index) => (
          <GroupWindow
            key={group.id}
            group={group}
            displayId={displayId}
            area={area}
            stackIndex={index + 1}
            hidden={quickHidden && !group.excludeFromQuickHide}
          />
        ))}
        <Marquee />
        {showHint && !quickHidden && (
          <EmptyHint
            area={area}
            onAutoOrganize={() => autoOrganizeDisplay(displayId, area, settings.iconSize)}
            onDismiss={() => useUiStore.getState().dismissHint()}
          />
        )}
      </DndProvider>
    </div>
  )
}
