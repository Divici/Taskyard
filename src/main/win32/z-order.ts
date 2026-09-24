import type { Hwnd, ZOrderMode } from './api'
import { HWND_BOTTOM, HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST, SWP_NOZORDER } from './constants'

/** Read-only z-order queries (`GetWindow`, `GetWindowLongPtrW`), injectable for tests. */
export interface ZOrderProbe {
  /** `GetWindow(hwnd, GW_HWNDPREV)`: the window directly above, or null at the top. */
  windowAbove(hwnd: Hwnd): Hwnd | null
  /** `GetWindow(hwnd, GW_HWNDNEXT)`: the window directly below, or null at the bottom. */
  windowBelow(hwnd: Hwnd): Hwnd | null
  /** `WS_EX_TOPMOST` is set. */
  isTopmost(hwnd: Hwnd): boolean
}

/** An `hWndInsertAfter` value (a real HWND or an `HWND_*` sentinel), or `keep` = no z change. */
export type InsertAfter = number | 'keep'

/**
 * Where `SetWindowPos` must insert `self` so it sits directly above `shell`.
 *
 * Inserting after a topmost window would make `self` topmost, so when the window above the
 * shell is topmost (or there is none — Win+D raised the shell to the top), `self` goes to the
 * top of the normal band instead: `HWND_TOP`, or `HWND_NOTOPMOST` if `self` is topmost (Peek).
 */
export function seatTarget(self: Hwnd, shell: Hwnd | null, probe: ZOrderProbe): InsertAfter {
  if (shell === null) return HWND_BOTTOM

  const selfTopmost = probe.isTopmost(self)
  const above = probe.windowAbove(shell)
  if (above === self) return selfTopmost ? HWND_NOTOPMOST : 'keep'
  if (above === null || probe.isTopmost(above)) return selfTopmost ? HWND_NOTOPMOST : HWND_TOP
  return Number(above)
}

/**
 * The `hWndInsertAfter` values to pass to successive `SetWindowPos` calls to reach `target`.
 * Windows ignores `HWND_TOP` from a process without foreground rights (the call succeeds but
 * nothing moves), which is exactly when a re-seat runs after Win+D; `HWND_TOPMOST` followed by
 * `HWND_NOTOPMOST` lands at the top of the normal band too, and is always allowed.
 */
export function seatSteps(target: InsertAfter): number[] {
  if (target === 'keep') return []
  if (target === HWND_TOP) return [HWND_TOPMOST, HWND_NOTOPMOST]
  return [target]
}

/** The z-order the guard enforces for `mode`. */
export function guardTarget(
  mode: ZOrderMode,
  self: Hwnd,
  shell: Hwnd | null,
  probe: ZOrderProbe
): InsertAfter {
  return mode === 'peek' ? HWND_TOPMOST : seatTarget(self, shell, probe)
}

/** The z-order fields of a `WINDOWPOS`. */
export interface WindowPosZ {
  hwndInsertAfter: number
  flags: number
}

/**
 * The `WINDOWPOS` the guard writes back for `target`, or null to leave it untouched. A change
 * that carries `SWP_NOZORDER` is a move/resize/show only and is never touched.
 */
export function rewriteWindowPos(pos: WindowPosZ, target: InsertAfter): WindowPosZ | null {
  if (pos.flags & SWP_NOZORDER) return null
  if (target === 'keep') {
    return { hwndInsertAfter: pos.hwndInsertAfter, flags: pos.flags | SWP_NOZORDER }
  }
  if (target === pos.hwndInsertAfter) return null
  return { hwndInsertAfter: target, flags: pos.flags }
}

/** Bounds every z-order walk: the list can change (or loop) underneath a walk. */
export const MAX_Z_ORDER_STEPS = 10_000

/**
 * True when `a` is above `b`. Walks down and up from `a` at the same time, so the cost is the
 * distance between the two windows: the sentinel's usual question ("is the shell above a seated
 * Taskyard window?") is answered in one step even with hundreds of windows in the z-order.
 */
export function isAboveInZOrder(
  a: Hwnd,
  b: Hwnd,
  probe: Pick<ZOrderProbe, 'windowAbove' | 'windowBelow'>,
  maxSteps = MAX_Z_ORDER_STEPS
): boolean {
  if (a === b) return false
  let down = probe.windowBelow(a)
  let up = probe.windowAbove(a)
  for (let step = 0; (down !== null || up !== null) && step < maxSteps; step++) {
    if (down === b) return true
    if (up === b) return false
    if (down !== null) down = probe.windowBelow(down)
    if (up !== null) up = probe.windowAbove(up)
  }
  return false
}
