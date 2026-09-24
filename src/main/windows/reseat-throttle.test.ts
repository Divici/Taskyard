import { describe, expect, it } from 'vitest'
import { createReseatThrottle, RESEAT_THROTTLE } from './reseat-throttle'

const options = { limit: 3, windowMs: 1_000, baseBackoffMs: 500, maxBackoffMs: 2_000 }

describe('RESEAT_THROTTLE', () => {
  it('allows 6 re-seats in 5 s, then backs off from 2 s up to 60 s', () => {
    expect(RESEAT_THROTTLE).toEqual({
      limit: 6,
      windowMs: 5_000,
      baseBackoffMs: 2_000,
      maxBackoffMs: 60_000
    })
  })
})

describe('createReseatThrottle', () => {
  it('lets re-seats through while they stay under the limit', () => {
    const throttle = createReseatThrottle(options)

    for (const now of [0, 100, 200]) {
      expect(throttle.allows(now)).toBe(true)
      expect(throttle.record(now)).toBe(0)
    }
    expect(throttle.allows(300)).toBe(true)
  })

  it('starts a back-off when the limit is passed inside the window', () => {
    const throttle = createReseatThrottle(options)
    for (const now of [0, 100, 200]) throttle.record(now)

    expect(throttle.record(300)).toBe(500)
    expect(throttle.allows(799)).toBe(false)
    expect(throttle.allows(800)).toBe(true)
  })

  it('forgets re-seats older than the window', () => {
    const throttle = createReseatThrottle(options)
    for (const now of [0, 100, 200]) throttle.record(now)

    expect(throttle.record(1_150)).toBe(0)
  })

  it('doubles the back-off while the fight goes on, up to the cap', () => {
    const throttle = createReseatThrottle(options)
    for (const now of [0, 100, 200, 300]) throttle.record(now)

    expect(throttle.record(800)).toBe(1_000)
    expect(throttle.record(1_800)).toBe(2_000)
    expect(throttle.record(3_800)).toBe(2_000)
  })

  it('ends the episode only after a full quiet window without re-seats', () => {
    const throttle = createReseatThrottle(options)
    for (const now of [0, 100, 200, 300]) throttle.record(now)

    expect(throttle.settle(900)).toBe(false)
    expect(throttle.settle(1_300)).toBe(true)
    expect(throttle.settle(1_400)).toBe(false)
    for (const now of [2_000, 2_100, 2_200]) expect(throttle.record(now)).toBe(0)
    expect(throttle.record(2_300)).toBe(500)
  })
})
