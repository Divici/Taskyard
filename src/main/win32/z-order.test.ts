import { describe, expect, it } from 'vitest'
import type { Hwnd } from './api'
import {
  HWND_BOTTOM,
  HWND_NOTOPMOST,
  HWND_TOP,
  HWND_TOPMOST,
  SWP_NOACTIVATE,
  SWP_NOZORDER
} from './constants'
import {
  guardTarget,
  isAboveInZOrder,
  MAX_Z_ORDER_STEPS,
  rewriteWindowPos,
  seatSteps,
  seatTarget,
  type ZOrderProbe
} from './z-order'

const SHELL = 0x100n
const SELF = 0x200n

/** A z-order list (top first) plus the set of topmost windows. */
function probe(order: Hwnd[], topmost: Hwnd[] = []): ZOrderProbe {
  return {
    windowAbove: (hwnd) => {
      const index = order.indexOf(hwnd)
      return index > 0 ? order[index - 1] : null
    },
    windowBelow: (hwnd) => {
      const index = order.indexOf(hwnd)
      return index >= 0 && index < order.length - 1 ? order[index + 1] : null
    },
    isTopmost: (hwnd) => topmost.includes(hwnd)
  }
}

describe('seatTarget', () => {
  it('inserts after the window currently directly above the shell window', () => {
    expect(seatTarget(SELF, SHELL, probe([SELF, 0x301n, 0x302n, SHELL]))).toBe(0x302)
  })

  it('keeps the z-order when the window already sits directly above the shell window', () => {
    expect(seatTarget(SELF, SHELL, probe([0x301n, SELF, SHELL]))).toBe('keep')
  })

  it('uses HWND_TOP when the shell window is at the top (after Win+D)', () => {
    expect(seatTarget(SELF, SHELL, probe([SHELL, SELF]))).toBe(HWND_TOP)
  })

  it('uses HWND_TOP rather than inserting after a topmost window, which would make it topmost', () => {
    const taskbar = 0x301n
    expect(seatTarget(SELF, SHELL, probe([taskbar, SHELL, SELF], [taskbar]))).toBe(HWND_TOP)
  })

  it('leaves the topmost band with HWND_NOTOPMOST when it is topmost and the shell is at the top', () => {
    expect(seatTarget(SELF, SHELL, probe([SELF, SHELL], [SELF]))).toBe(HWND_NOTOPMOST)
    const overlay = 0x301n
    expect(seatTarget(SELF, SHELL, probe([SELF, overlay, SHELL], [SELF, overlay]))).toBe(
      HWND_NOTOPMOST
    )
  })

  it('drops a topmost window straight above the shell by inserting after a normal window', () => {
    expect(seatTarget(SELF, SHELL, probe([SELF, 0x301n, SHELL], [SELF]))).toBe(0x301)
  })

  it('goes to the bottom while Explorer is not running', () => {
    expect(seatTarget(SELF, null, probe([0x301n, SELF]))).toBe(HWND_BOTTOM)
  })
})

describe('seatSteps', () => {
  it('is one SetWindowPos with the target', () => {
    expect(seatSteps(0x301)).toEqual([0x301])
    expect(seatSteps(HWND_NOTOPMOST)).toEqual([HWND_NOTOPMOST])
    expect(seatSteps(HWND_BOTTOM)).toEqual([HWND_BOTTOM])
  })

  it('is nothing when the window keeps its place', () => {
    expect(seatSteps('keep')).toEqual([])
  })

  it('reaches the top of the normal band via topmost and back, since a background HWND_TOP is ignored', () => {
    expect(seatSteps(HWND_TOP)).toEqual([HWND_TOPMOST, HWND_NOTOPMOST])
  })
})

describe('guardTarget', () => {
  it('forces HWND_TOPMOST while peeking when there is no taskbar', () => {
    expect(guardTarget('peek', SELF, SHELL, probe([0x301n, SHELL, SELF]))).toBe(HWND_TOPMOST)
  })

  it('Phase 12: peeks directly below the taskbar, so Start, the clock and the tray stay usable', () => {
    const taskbar = 0x400n
    const z = probe([taskbar, 0x301n, SHELL, SELF], [taskbar])
    expect(guardTarget('peek', SELF, SHELL, z, [taskbar])).toBe(Number(taskbar))
  })

  it('Phase 12: with several taskbars (one per monitor), below the lowest one', () => {
    const primary = 0x400n
    const secondary = 0x401n
    const z = probe([secondary, primary, 0x301n, SHELL, SELF], [primary, secondary])
    expect(guardTarget('peek', SELF, SHELL, z, [primary, secondary])).toBe(Number(primary))
  })

  it('Phase 12: keeps its place when it already sits directly below the lowest taskbar', () => {
    const taskbar = 0x400n
    const z = probe([taskbar, SELF, 0x301n, SHELL], [taskbar, SELF])
    expect(guardTarget('peek', SELF, SHELL, z, [taskbar])).toBe('keep')
  })

  it('Phase 12: a taskbar that is not topmost is no anchor (inserting after it would not raise us)', () => {
    const taskbar = 0x400n
    const z = probe([taskbar, 0x301n, SHELL, SELF])
    expect(guardTarget('peek', SELF, SHELL, z, [taskbar])).toBe(HWND_TOPMOST)
  })

  it('seats above the shell window otherwise', () => {
    expect(guardTarget('bottom', SELF, SHELL, probe([SELF, 0x301n, SHELL]))).toBe(0x301)
  })
})

describe('rewriteWindowPos', () => {
  it('replaces hwndInsertAfter with the target', () => {
    expect(rewriteWindowPos({ hwndInsertAfter: HWND_TOP, flags: SWP_NOACTIVATE }, 0x301)).toEqual({
      hwndInsertAfter: 0x301,
      flags: SWP_NOACTIVATE
    })
  })

  it('never touches a change that carries SWP_NOZORDER', () => {
    expect(rewriteWindowPos({ hwndInsertAfter: 0, flags: SWP_NOZORDER }, 0x301)).toBeNull()
  })

  it('adds SWP_NOZORDER when the window must keep its place', () => {
    expect(rewriteWindowPos({ hwndInsertAfter: HWND_TOP, flags: SWP_NOACTIVATE }, 'keep')).toEqual({
      hwndInsertAfter: HWND_TOP,
      flags: SWP_NOACTIVATE | SWP_NOZORDER
    })
  })

  it('reports no change when the request already matches the target', () => {
    expect(rewriteWindowPos({ hwndInsertAfter: HWND_TOPMOST, flags: 0 }, HWND_TOPMOST)).toBeNull()
  })
})

describe('isAboveInZOrder', () => {
  const order = [0x1n, 0x2n, 0x3n, 0x4n]

  it('is true when the first window is higher in the z-order', () => {
    expect(isAboveInZOrder(0x1n, 0x4n, probe(order))).toBe(true)
    expect(isAboveInZOrder(0x2n, 0x3n, probe(order))).toBe(true)
  })

  it('is false when the first window is lower, the same, or not in the chain', () => {
    expect(isAboveInZOrder(0x4n, 0x1n, probe(order))).toBe(false)
    expect(isAboveInZOrder(0x2n, 0x2n, probe(order))).toBe(false)
    expect(isAboveInZOrder(0x9n, 0x1n, probe(order))).toBe(false)
  })

  it('costs steps in proportion to the distance, not to the size of the z-order', () => {
    // 1000 windows; the shell near the bottom with Taskyard directly above it (the seated case).
    const many = Array.from({ length: 1000 }, (_, index) => BigInt(index + 1))
    const counting = probe(many)
    let steps = 0
    const counted: ZOrderProbe = {
      windowAbove: (hwnd) => (steps++, counting.windowAbove(hwnd)),
      windowBelow: (hwnd) => (steps++, counting.windowBelow(hwnd)),
      isTopmost: counting.isTopmost
    }

    expect(isAboveInZOrder(990n, 989n, counted)).toBe(false) // "is the shell above Taskyard?"
    expect(steps).toBeLessThanOrEqual(2)
    steps = 0
    expect(isAboveInZOrder(989n, 990n, counted)).toBe(true)
    expect(steps).toBeLessThanOrEqual(2)
  })

  it('stops walking a z-order chain that loops', () => {
    const loop = (hwnd: Hwnd): Hwnd => (hwnd === 0x1n ? 0x2n : 0x1n)
    const looping: ZOrderProbe = { windowAbove: loop, windowBelow: loop, isTopmost: () => false }
    expect(isAboveInZOrder(0x1n, 0x3n, looping, 50)).toBe(false)
  })

  it('bounds every walk by one shared limit', () => {
    expect(MAX_Z_ORDER_STEPS).toBe(10_000)
  })
})
