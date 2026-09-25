import { TOOLS_VALUES } from '@shared/defaults'
import { localWorkArea, snapValue } from '@shared/geometry'
import type { DisplayInfo } from '@shared/ipc'
import type { ToolsState } from '@shared/schema'
import { isPrimaryDisplay } from './reconcile-sync'

/** The tools widget's gap from the work area's top-right corner when it first appears. */
export const TOOLS_MARGIN = 24

/**
 * Where a display's tools widget starts when the display is seen for the first time: the top
 * right of its work area (loose icons fill from the top left, like Windows), shown on the
 * primary display only.
 */
export function initialToolsPlacement(
  info: Pick<DisplayInfo, 'bounds' | 'workArea'>
): Pick<ToolsState, 'visible' | 'x' | 'y'> {
  const area = localWorkArea(info)
  return {
    visible: isPrimaryDisplay(info),
    x: snapValue(Math.max(area.x, area.x + area.width - TOOLS_VALUES.w - TOOLS_MARGIN)),
    y: snapValue(area.y + TOOLS_MARGIN)
  }
}
