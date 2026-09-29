import type { CSSProperties } from 'react'
import { localWorkArea } from '@shared/geometry'
import type { DisplayInfo } from '@shared/ipc'

/** Gap between the toasts and the work area's bottom edge (px). */
const TOAST_MARGIN = 24
/** A toast is 26rem wide at most, and 1rem short of the work area on either side. */
const TOAST_MAX_WIDTH = 416
const TOAST_SIDE_GAP = 16

/**
 * Round 2: where the toasts sit in this display's window — centred on the work area and 24 px
 * above its bottom edge, so they are never under the taskbar or cut off by the screen edge.
 */
export function toastPlacement(info: Pick<DisplayInfo, 'bounds' | 'workArea'>): CSSProperties {
  const area = localWorkArea(info)
  return {
    left: area.x + area.width / 2,
    bottom: info.bounds.height - (area.y + area.height) + TOAST_MARGIN,
    width: Math.max(0, Math.min(TOAST_MAX_WIDTH, area.width - 2 * TOAST_SIDE_GAP)),
    maxHeight: Math.max(0, area.height - 2 * TOAST_MARGIN)
  }
}
