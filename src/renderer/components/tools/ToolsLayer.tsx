import { useEffect } from 'react'
import { clampRect } from '@shared/geometry'
import type { DisplayInfo } from '@shared/ipc'
import type { Rect, ToolsState } from '@shared/schema'
import { isPrimaryDisplay } from '../../lib/reconcile-sync'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { TimerCompletion } from './timer/TimerCompletion'
import { ToolsWidget } from './ToolsWidget'

export interface ToolsLayerProps {
  displayId: number
  info: DisplayInfo
  /** The display's work area in window coordinates. */
  area: Rect
  /** Above every group. */
  zIndex: number
  /** Quick-hide. */
  hidden: boolean
}

/** The widget pulled back inside the work area (the same object when it already is). */
function clampedInto(area: Rect): (tools: ToolsState) => ToolsState {
  return (tools) => {
    const rect = { x: tools.x, y: tools.y, width: tools.w, height: tools.h }
    const clamped = clampRect(rect, area)
    return clamped === rect
      ? tools
      : { ...tools, x: clamped.x, y: clamped.y, w: clamped.width, h: clamped.height }
  }
}

/**
 * One display's tools: the widget when Settings' `toolsEnabled` is on and this display's layout
 * shows it (by default only the primary display's does), and — in the primary display's window,
 * whether or not the widget is shown — the timer's completion watcher.
 */
export function ToolsLayer({
  displayId,
  info,
  area,
  zIndex,
  hidden
}: ToolsLayerProps): React.JSX.Element {
  const enabled = useSettingsStore((state) => state.settings.toolsEnabled)
  const visible = useLayoutStore(
    (state) =>
      state.layout.displays.find((display) => display.displayId === displayId)?.tools.visible ??
      false
  )
  const layoutHydrated = useLayoutStore((state) => state.hydrated)

  // Soft clamp, like the groups: a work area that changed pulls the widget back inside it.
  useEffect(() => {
    if (!layoutHydrated) return
    useLayoutStore.getState().updateTools(displayId, clampedInto(area))
  }, [area, displayId, layoutHydrated])

  return (
    <>
      <TimerCompletion leader={isPrimaryDisplay(info)} />
      {enabled && visible && (
        <ToolsWidget displayId={displayId} area={area} zIndex={zIndex} hidden={hidden} />
      )}
    </>
  )
}
