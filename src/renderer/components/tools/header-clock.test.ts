import { describe, expect, it } from 'vitest'
import { headerClockFor } from './header-clock'

const idle = { status: 'idle' } as const
const running = { status: 'running' } as const
const paused = { status: 'paused' } as const

describe('headerClockFor', () => {
  it('shows the countdown whenever it is in progress and the Timer tool is not on screen', () => {
    expect(headerClockFor('timer', false, running, idle)).toBeNull()
    expect(headerClockFor('timer', true, running, idle)).toBe('timer')
    expect(headerClockFor('tasks', false, paused, idle)).toBe('timer')
    expect(headerClockFor('stopwatch', false, running, idle)).toBe('timer')
  })

  it('rolled up on the Stopwatch tab, shows the stopwatch (running or paused)', () => {
    expect(headerClockFor('stopwatch', true, idle, running)).toBe('stopwatch')
    expect(headerClockFor('stopwatch', true, idle, paused)).toBe('stopwatch')
    expect(headerClockFor('stopwatch', true, idle, idle)).toBeNull()
  })

  it('never shows the stopwatch expanded or on another tab', () => {
    expect(headerClockFor('stopwatch', false, idle, running)).toBeNull()
    expect(headerClockFor('tasks', true, idle, running)).toBeNull()
    expect(headerClockFor('timer', true, idle, running)).toBeNull()
  })

  it('the countdown keeps priority when both are counting', () => {
    expect(headerClockFor('stopwatch', true, running, running)).toBe('timer')
    expect(headerClockFor('stopwatch', true, paused, running)).toBe('timer')
  })
})
