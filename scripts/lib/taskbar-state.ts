/** SHAppBarMessage `ABM_GETSTATE`/`ABM_SETSTATE` bits. */
export const ABS_AUTOHIDE = 0x1
export const ABS_ALWAYSONTOP = 0x2

/** The appbar state with auto-hide turned on, everything else kept. */
export function withAutoHide(state: number): number {
  return state | ABS_AUTOHIDE
}

/**
 * A bottom-docked taskbar is revealed when it lies fully on screen; auto-hide slides it down so
 * only a 2 px sliver remains above the monitor's bottom edge.
 */
export function isTaskbarRevealed(
  rect: { top: number; bottom: number },
  monitorBottom: number
): boolean {
  return rect.bottom <= monitorBottom
}
