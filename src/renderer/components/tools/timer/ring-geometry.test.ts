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

  it('the "Focus: <task>" label stays inside the ring at its lowest edge, with breathing room', () => {
    // The label's bottom edge sits `bottom` px below the centre of the ring.
    const { maxWidth, bottom, padding } = RING_LABEL
    expect(maxWidth + 2 * padding).toBeLessThanOrEqual(innerChordWidth(bottom))
  })
})
