import { describe, expect, it } from 'vitest'
import { ABS_ALWAYSONTOP, ABS_AUTOHIDE, isTaskbarRevealed, withAutoHide } from './taskbar-state'

describe('withAutoHide', () => {
  it('turns auto-hide on and keeps the always-on-top bit', () => {
    expect(withAutoHide(0)).toBe(ABS_AUTOHIDE)
    expect(withAutoHide(ABS_ALWAYSONTOP)).toBe(ABS_AUTOHIDE | ABS_ALWAYSONTOP)
    expect(withAutoHide(ABS_AUTOHIDE)).toBe(ABS_AUTOHIDE)
  })
})

describe('isTaskbarRevealed', () => {
  // Measured on the 2560x1440 primary display with a 48 px taskbar.
  it('is true when the bottom taskbar sits fully on screen', () => {
    expect(isTaskbarRevealed({ top: 1392, bottom: 1440 }, 1440)).toBe(true)
  })

  it('is false when auto-hide has slid it down to a 2 px sliver', () => {
    expect(isTaskbarRevealed({ top: 1438, bottom: 1486 }, 1440)).toBe(false)
  })
})
