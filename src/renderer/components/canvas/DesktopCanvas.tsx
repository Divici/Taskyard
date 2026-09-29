import { useEffect, useMemo, useState } from 'react'
import { clampRect, localWorkArea } from '@shared/geometry'
import { looseCell, visibleGroupRect } from '@shared/group-metrics'
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
import { openMenuFromKey } from '../../lib/context-menu-key'
import { LAUNCH_REVEAL_WINDOW_MS, revealOrder } from '../../lib/motion'
import { toggleQuickHide } from '../../lib/quick-hide'
import { isPrimaryDisplay } from '../../lib/reconcile-sync'
import { useItemsStore } from '../../stores/items'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import { CanvasDropZone } from '../dnd/CanvasDropZone'
import { DndProvider } from '../dnd/DndProvider'
import { useExternalDrop } from '../dnd/useExternalDrop'
import { GroupWindow } from '../group/GroupWindow'
import { Inspector } from '../inspector/Inspector'
import { FirstRun } from '../onboarding/FirstRun'
import { toggleToolsOn } from '../tools/tools-actions'
import { ToolsLayer } from '../tools/ToolsLayer'
import { CanvasContextMenu } from './CanvasContextMenu'
import { EmptyHint } from './EmptyHint'
import { LooseIconLayer } from './LooseIconLayer'
import { Marquee } from './Marquee'
import { SnapGuides } from './SnapGuides'
import { useMarquee } from './useMarquee'

export interface DesktopCanvasProps {
  displayId: number
  info: DisplayInfo
}

const NO_GROUPS: readonly Group[] = []
const NO_LOOSE: Readonly<Record<string, Point>> = {}

/**
 * A group pulled back inside the work area (the same group when it already is). A rolled-up group
 * only keeps its title bar inside; rolled down it grows upward if it must (toggleGroupRollUp).
 */
function clampedInto(area: ReturnType<typeof localWorkArea>): (group: Group) => Group {
  return (group) => {
    const rect = visibleGroupRect(group)
    const clamped = clampRect(rect, area)
    if (clamped === rect) return group
    const h = group.rolledUp ? group.h : clamped.height
    return { ...group, x: clamped.x, y: clamped.y, w: clamped.width, h }
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
  const settingsHydrated = useSettingsStore((state) => state.hydrated)
  const inspectorOpen = useUiStore((state) => state.inspectorOpen)
  const quickHidden = useUiStore((state) => state.quickHidden)
  const hintDismissed = useUiStore((state) => state.hintDismissed)
  const toolsShown = settings.toolsEnabled && (entry?.tools.visible ?? false) // Phase 10: the menu's wording

  const groups = entry?.groups ?? NO_GROUPS
  const loose = entry?.loose ?? NO_LOOSE
  const { x, y, width, height } = localWorkArea(info)
  const area = useMemo(() => ({ x, y, width, height }), [x, y, width, height])
  const cell = looseCell(settings.iconSize)
  // Round 2: the grid step for new groups (null: grid snap off).
  const grid = settings.gridSnap ? settings.gridSize : null

  // Groups render in the layout's (stable) order and stack by their rank of `z`. Sorting the
  // elements by z made React move a group's node when a press raised it, and Chromium drops the
  // click of a press whose node moved: the chevron needed a second click (round 2).
  const stackRank = useMemo(() => {
    const byZ = [...groups].sort((a, b) => a.z - b.z)
    return new Map(byZ.map((group, index) => [group.id, index + 1]))
  }, [groups])

  // Phase 12: the groups present at launch enter one after another (lib/motion.ts); a group
  // made later — or made by the user while the launch entrance runs — just appears.
  const [mountedAt] = useState(() => Date.now())
  const [launching, setLaunching] = useState(true)
  useEffect(() => {
    if (!layoutHydrated || !launching) return
    const timer = setTimeout(() => setLaunching(false), LAUNCH_REVEAL_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [layoutHydrated, launching])
  const entrance = useMemo(
    () => (launching ? revealOrder(groups.filter((group) => group.createdAt < mountedAt)) : null),
    [launching, groups, mountedAt]
  )
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
    onDrawGroup: (rect, ids) => groupFromMarquee(displayId, rect, area, grid, ids)
  })

  // Phase 11: the first-run card, once, on the primary display (it takes the hint's place).
  const showFirstRun = settingsHydrated && !settings.firstRunDone && isPrimaryDisplay(info)
  const showHint = !showFirstRun && !hintDismissed && groups.length === 0 && looseTargets.length > 0
  // Phase 8: files dropped from Explorer (native events; dnd-kit handles our own icons).
  const externalDrop = useExternalDrop({ displayId, area, cell })

  return (
    <div data-desktop-canvas={displayId} className="absolute inset-0" {...externalDrop}>
      <DndProvider displayId={displayId} area={area} cell={cell}>
        <CanvasContextMenu
          onNewGroup={(point) => newGroupAt(displayId, point, area, grid)}
          onAutoOrganize={() => void confirmAutoOrganize(displayId, area, settings.iconSize)}
          onSortLoose={() => sortLooseIcons(displayId, area, settings.iconSize)}
          onRefresh={refreshDesktop}
          onSettings={() => useUiStore.getState().setInspectorOpen(true)}
          onOpenSettingsPage={openSettingsPage}
          onQuit={quitApp}
          toolsShown={toolsShown}
          onToggleTools={() => toggleToolsOn(displayId)}
        >
          <div
            data-canvas-surface=""
            // Phase 12: the desktop itself is a Tab stop, so its menu has a keyboard route
            // (Shift+F10 / the menu key), as on the Windows desktop.
            role="application"
            aria-label="Desktop"
            aria-roledescription="desktop"
            tabIndex={0}
            onKeyDown={(event) => openMenuFromKey(event, 'center')}
            className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-accent-1/60 focus-visible:ring-inset"
            {...marquee.handlers}
            onDoubleClick={() => {
              // Phase 9: every display hides together (lib/quick-hide.ts).
              if (settings.quickHideOnDoubleClick) toggleQuickHide()
            }}
          />
        </CanvasContextMenu>
        <CanvasDropZone cell={cell} />
        <LooseIconLayer
          displayId={displayId}
          loose={loose}
          byId={byId}
          cell={cell}
          iconSize={settings.iconSize}
          showExtension={settings.showExtensions}
          hidden={quickHidden}
        />
        {groups.map((group) => (
          <GroupWindow
            key={group.id}
            group={group}
            displayId={displayId}
            area={area}
            stackIndex={stackRank.get(group.id)}
            hidden={quickHidden && !group.excludeFromQuickHide}
            revealIndex={entrance?.get(group.id)}
          />
        ))}
        {/* Phase 10: the tools widget (above the groups) and the timer's completion watcher. */}
        <ToolsLayer
          displayId={displayId}
          info={info}
          area={area}
          zIndex={groups.length + 1}
          hidden={quickHidden}
        />
        {/* Round 2: alignment guides while a group or the tools widget moves or resizes. */}
        <SnapGuides zIndex={groups.length + 2} />
        <Marquee />
        {showHint && !quickHidden && (
          <EmptyHint
            area={area}
            onAutoOrganize={() => autoOrganizeDisplay(displayId, area, settings.iconSize)}
            onDismiss={() => useUiStore.getState().dismissHint()}
          />
        )}
        {showFirstRun && !quickHidden && <FirstRun displayId={displayId} area={area} />}
        {/* Phase 11: the settings inspector (canvas menu › Settings, the tray). */}
        {inspectorOpen && <Inspector displayId={displayId} area={area} />}
      </DndProvider>
    </div>
  )
}
