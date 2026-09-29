import { describe, expect, it } from 'vitest'
import {
  RING_INNER_RADIUS,
  RING_LABEL,
  RING_RADIUS,
  RING_SIZE,
  RING_STROKE,
  innerChordWidth
} from './ring-geometry'

describe('timer ring geometry', () => {
  it('the inner radius is the arc radius less half the stroke', () => {
    expect(RING_RADIUS).toBe((RING_SIZE - RING_STROKE) / 2 - 6)
    expect(RING_INNER_RADIUS).toBe(RING_RADIUS - RING_STROKE / 2)
  })

  it('a chord is the full inner diameter at the centre and zero at the edge', () => {
    expect(innerChordWidth(0)).toBeCloseTo(RING_INNER_RADIUS * 2)
    expect(innerChordWidth(RING_INNER_RADIUS)).toBe(0)
    expect(innerChordWidth(RING_INNER_RADIUS + 5)).toBe(0)
  })

  it('round 2: the state caption sits under the centred clock and inside the ring', () => {
    // The clock is centred in the ring (34 px type on a ~41 px line: 21 px above and below the centre); the
    // caption's 16 px line starts `top` px below the centre, so it never overlaps the clock.
    const { maxWidth, top, bottom, padding } = RING_LABEL
    expect(top).toBeGreaterThanOrEqual(21)
    expect(bottom).toBe(top + 16)
    // At its lowest edge it still fits inside the stroke, with breathing room on both sides.
    expect(maxWidth + 2 * padding).toBeLessThanOrEqual(innerChordWidth(bottom))
  })
})
