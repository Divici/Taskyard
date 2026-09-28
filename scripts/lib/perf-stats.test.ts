import { describe, expect, it } from 'vitest'
import { frameIntervals, percentile, summarizeFrames } from './perf-stats'

describe('percentile (nearest rank)', () => {
  it('p50 and p95 of 1..100', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(values, 50)).toBe(50)
    expect(percentile(values, 95)).toBe(95)
    expect(percentile(values, 100)).toBe(100)
  })

  it('does not care about input order and rejects an empty list', () => {
    expect(percentile([30, 10, 20], 50)).toBe(20)
    expect(() => percentile([], 95)).toThrow(/no values/)
  })
})

describe('frame intervals', () => {
  it('are the gaps between consecutive rAF timestamps', () => {
    expect(frameIntervals([0, 16.7, 33.4, 60])).toEqual(
      [16.7, 16.7, 26.6].map((v) => expect.closeTo(v, 5))
    )
  })

  it('summarize: count, median, p95, worst and the implied refresh rate', () => {
    const stamps = Array.from({ length: 181 }, (_, i) => i * 16.67)
    stamps.push(stamps.at(-1)! + 40) // one long frame
    const summary = summarizeFrames(stamps)
    expect(summary.frames).toBe(181)
    expect(summary.medianMs).toBeCloseTo(16.67, 2)
    expect(summary.p95Ms).toBeCloseTo(16.67, 2)
    expect(summary.worstMs).toBeCloseTo(40, 2)
    expect(summary.refreshHz).toBe(60)
  })
})
