// Frame-time statistics for e2e/perf.spec.ts (Phase 12): in-page requestAnimationFrame
// timestamps → intervals → p95. Pure, so it is unit-tested with the scripts.

/** Nearest-rank percentile (`p` in 0–100) of `values`, in any order. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('percentile: no values')
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[Math.min(rank, sorted.length) - 1]
}

/** Gaps between consecutive timestamps (ms). */
export function frameIntervals(stamps: readonly number[]): number[] {
  return stamps.slice(1).map((stamp, i) => stamp - stamps[i])
}

export interface FrameSummary {
  /** Intervals measured. */
  frames: number
  medianMs: number
  p95Ms: number
  worstMs: number
  /** 1000 / median, rounded: the monitor's refresh rate when nothing is dropped. */
  refreshHz: number
}

export function summarizeFrames(stamps: readonly number[]): FrameSummary {
  const intervals = frameIntervals(stamps)
  const medianMs = percentile(intervals, 50)
  return {
    frames: intervals.length,
    medianMs,
    p95Ms: percentile(intervals, 95),
    worstMs: Math.max(...intervals),
    refreshHz: Math.round(1000 / medianMs)
  }
}
