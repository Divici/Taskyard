import { describe, expect, it } from 'vitest'
import { TIMER_MAX_MS } from '@shared/timer-state'
import { customDuration, splitDuration } from './custom-duration'

describe('splitDuration', () => {
  it('splits a duration into whole hours and the minutes left over', () => {
    expect(splitDuration(25 * 60_000)).toEqual({ hours: '0', minutes: '25' })
    expect(splitDuration(90 * 60_000)).toEqual({ hours: '1', minutes: '30' })
    expect(splitDuration(TIMER_MAX_MS)).toEqual({ hours: '99', minutes: '59' })
  })
})

describe('customDuration', () => {
  it('combines hours and minutes', () => {
    expect(customDuration('0', '25')).toBe(25 * 60_000)
    expect(customDuration('4', '0')).toBe(4 * 3_600_000)
    expect(customDuration('99', '59')).toBe(TIMER_MAX_MS)
  })

  it('refuses blanks, fractions, negatives and anything past each field’s range', () => {
    expect(customDuration('', '25')).toBeNull()
    expect(customDuration('1', '')).toBeNull()
    expect(customDuration('1.5', '0')).toBeNull()
    expect(customDuration('-1', '30')).toBeNull()
    expect(customDuration('0', '60')).toBeNull()
    expect(customDuration('100', '0')).toBeNull()
  })

  it('needs at least a minute in all', () => {
    expect(customDuration('0', '0')).toBeNull()
    expect(customDuration('0', '1')).toBe(60_000)
  })
})
