import { describe, expect, it } from 'vitest'
import { defaultStopwatch, emptyTasks } from './defaults'
import type { StopwatchState } from './schema'
import { StopwatchStateSchema, TasksFileSchema } from './schema'
import {
  formatStopwatch,
  lapStopwatch,
  linkStopwatchTask,
  pauseStopwatch,
  resetStopwatch,
  resumeStopwatch,
  startStopwatch,
  STOPWATCH_MAX_LAPS,
  stopwatchElapsed
} from './stopwatch-state'

const NOW = 1_000_000
const idle = (patch: Partial<StopwatchState> = {}): StopwatchState => ({
  ...defaultStopwatch(),
  ...patch
})
const running = (startedAt: number, patch: Partial<StopwatchState> = {}): StopwatchState =>
  idle({ status: 'running', startedAt, ...patch })

describe('stopwatch state', () => {
  it('a new stopwatch is idle at zero with no laps', () => {
    expect(defaultStopwatch()).toEqual({ status: 'idle', accumulatedMs: 0, laps: [] })
    expect(stopwatchElapsed(defaultStopwatch(), NOW)).toBe(0)
  })

  it('start stores an absolute startedAt, so the elapsed time is read from the clock', () => {
    const started = startStopwatch(idle(), NOW)

    expect(started).toEqual({ status: 'running', startedAt: NOW, accumulatedMs: 0, laps: [] })
    expect(stopwatchElapsed(started, NOW + 12_345)).toBe(12_345)
    // Hours later (sleep, restart): still right, never drifting with ticks.
    expect(stopwatchElapsed(started, NOW + 3 * 3_600_000)).toBe(3 * 3_600_000)
  })

  it('start leaves a running or paused stopwatch alone', () => {
    const run = running(NOW)
    const paused = idle({ status: 'paused', accumulatedMs: 5_000 })

    expect(startStopwatch(run, NOW + 1)).toBe(run)
    expect(startStopwatch(paused, NOW + 1)).toBe(paused)
  })

  it('pause banks the elapsed time; resume continues from it', () => {
    const paused = pauseStopwatch(running(NOW, { accumulatedMs: 1_000 }), NOW + 4_000)
    expect(paused).toEqual(idle({ status: 'paused', accumulatedMs: 5_000 }))
    expect(stopwatchElapsed(paused, NOW + 60_000)).toBe(5_000)

    const resumed = resumeStopwatch(paused, NOW + 60_000)
    expect(resumed).toEqual(running(NOW + 60_000, { accumulatedMs: 5_000 }))
    expect(stopwatchElapsed(resumed, NOW + 62_500)).toBe(7_500)
  })

  it('pause and resume are no-ops in the wrong state', () => {
    const stopped = idle()
    const run = running(NOW)

    expect(pauseStopwatch(stopped, NOW)).toBe(stopped)
    expect(resumeStopwatch(stopped, NOW)).toBe(stopped)
    expect(resumeStopwatch(run, NOW)).toBe(run)
  })

  it('a clock that went backwards never gives a negative time', () => {
    expect(stopwatchElapsed(running(NOW), NOW - 5_000)).toBe(0)
    expect(pauseStopwatch(running(NOW, { accumulatedMs: 2_000 }), NOW - 5_000)).toMatchObject({
      status: 'paused',
      accumulatedMs: 2_000
    })
  })

  it('reset goes back to zero and forgets the laps (the linked task stays)', () => {
    const lapped = running(NOW, {
      accumulatedMs: 3_000,
      laps: [{ n: 1, totalMs: 2_000, splitMs: 2_000 }],
      linkedTaskId: 't'
    })

    expect(resetStopwatch(lapped)).toEqual(idle({ linkedTaskId: 't' }))
    const clean = idle()
    expect(resetStopwatch(clean)).toBe(clean)
  })

  it('lap records the total and the split, newest first', () => {
    let watch = startStopwatch(idle(), NOW)
    watch = lapStopwatch(watch, NOW + 1_500)
    watch = lapStopwatch(watch, NOW + 4_000)

    expect(watch.laps).toEqual([
      { n: 2, totalMs: 4_000, splitMs: 2_500 },
      { n: 1, totalMs: 1_500, splitMs: 1_500 }
    ])
  })

  it('a lap counts the time banked before a pause', () => {
    let watch = startStopwatch(idle(), NOW)
    watch = pauseStopwatch(watch, NOW + 2_000)
    watch = resumeStopwatch(watch, NOW + 10_000)
    watch = lapStopwatch(watch, NOW + 11_000)

    expect(watch.laps).toEqual([{ n: 1, totalMs: 3_000, splitMs: 3_000 }])
  })

  it('lap only applies while running', () => {
    const stopped = idle()
    const paused = idle({ status: 'paused', accumulatedMs: 1_000 })

    expect(lapStopwatch(stopped, NOW)).toBe(stopped)
    expect(lapStopwatch(paused, NOW)).toBe(paused)
  })

  it('keeps at most 50 laps, dropping the oldest (numbers keep counting)', () => {
    let watch = startStopwatch(idle(), NOW)
    for (let i = 1; i <= STOPWATCH_MAX_LAPS + 2; i += 1)
      watch = lapStopwatch(watch, NOW + i * 1_000)

    expect(STOPWATCH_MAX_LAPS).toBe(50)
    expect(watch.laps).toHaveLength(50)
    expect(watch.laps[0]).toEqual({ n: 52, totalMs: 52_000, splitMs: 1_000 })
    expect(watch.laps.at(-1)).toMatchObject({ n: 3 })
  })

  it('a lap replayed on data where a later lap already exists never has a negative split', () => {
    const later = running(NOW, { laps: [{ n: 1, totalMs: 5_000, splitMs: 5_000 }] })

    expect(lapStopwatch(later, NOW + 4_000).laps[0]).toEqual({ n: 2, totalMs: 4_000, splitMs: 0 })
  })

  it('links and unlinks a task', () => {
    const linked = linkStopwatchTask(idle(), 't')
    expect(linked.linkedTaskId).toBe('t')
    expect(linkStopwatchTask(linked, 't')).toBe(linked)
    expect('linkedTaskId' in linkStopwatchTask(linked, null)).toBe(false)
  })

  it('formats h:mm:ss.t (tenths, rounded down)', () => {
    expect(formatStopwatch(0)).toBe('0:00:00.0')
    expect(formatStopwatch(1_299)).toBe('0:00:01.2')
    expect(formatStopwatch(61_950)).toBe('0:01:01.9')
    expect(formatStopwatch(3_723_456)).toBe('1:02:03.4')
    expect(formatStopwatch(-50)).toBe('0:00:00.0')
  })
})

describe('StopwatchStateSchema', () => {
  it('an older tasks.json without a stopwatch gets an idle one (no version bump)', () => {
    expect(TasksFileSchema.parse({ version: 1 }).stopwatch).toEqual(defaultStopwatch())
    expect(emptyTasks().stopwatch).toEqual(defaultStopwatch())
  })

  it('requires startedAt while running', () => {
    expect(StopwatchStateSchema.safeParse({ status: 'running' }).success).toBe(false)
    expect(StopwatchStateSchema.safeParse(running(NOW)).success).toBe(true)
  })

  it('holds at most 50 laps', () => {
    const lap = { n: 1, totalMs: 1, splitMs: 1 }
    const laps = Array.from({ length: 51 }, () => lap)

    expect(StopwatchStateSchema.safeParse(idle({ laps: laps.slice(1) })).success).toBe(true)
    expect(StopwatchStateSchema.safeParse(idle({ laps })).success).toBe(false)
  })
})
