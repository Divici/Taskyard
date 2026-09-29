import { STOPWATCH_MAX_LAPS } from './defaults'
import type { StopwatchState } from './schema'

// Pure stopwatch transitions over tasks.json's `stopwatch` (round 2). Like the timer's
// (timer-state.ts), each one is an updater for `updateStopwatch`: it reads only the stopwatch it
// receives, so a replay on another window's newer data stays correct, and it returns the same
// object when the transition does not apply. A running stopwatch stores an absolute `startedAt`
// plus the time banked before it, never a tick count, so it survives sleep and restarts.

export { STOPWATCH_MAX_LAPS }

/** A copy without the running-only field. */
function withoutRun(watch: StopwatchState): StopwatchState {
  const next = { ...watch }
  delete next.startedAt
  return next
}

/** Elapsed milliseconds now: the banked time plus the current run (never negative). */
export function stopwatchElapsed(watch: StopwatchState, now: number): number {
  const banked = Math.max(0, watch.accumulatedMs)
  if (watch.status !== 'running' || watch.startedAt === undefined) return banked
  return banked + Math.max(0, now - watch.startedAt)
}

/** Idle → running from zero (the laps of an earlier run were cleared by Reset). */
export function startStopwatch(watch: StopwatchState, now: number): StopwatchState {
  if (watch.status !== 'idle') return watch
  return { ...watch, status: 'running', startedAt: now, accumulatedMs: 0, laps: [] }
}

/** Running → paused, banking the elapsed time. */
export function pauseStopwatch(watch: StopwatchState, now: number): StopwatchState {
  if (watch.status !== 'running') return watch
  const accumulatedMs = Math.round(stopwatchElapsed(watch, now))
  return { ...withoutRun(watch), status: 'paused', accumulatedMs }
}

/** Paused → running, continuing from the banked time. */
export function resumeStopwatch(watch: StopwatchState, now: number): StopwatchState {
  if (watch.status !== 'paused') return watch
  return { ...watch, status: 'running', startedAt: now }
}

/** Anything → idle at zero with no laps (the linked task is kept). */
export function resetStopwatch(watch: StopwatchState): StopwatchState {
  if (
    watch.status === 'idle' &&
    watch.startedAt === undefined &&
    watch.accumulatedMs === 0 &&
    watch.laps.length === 0
  ) {
    return watch
  }
  return { ...withoutRun(watch), status: 'idle', accumulatedMs: 0, laps: [] }
}

/**
 * Running: records a lap (total and split), newest first, keeping the latest 50. Lap numbers keep
 * counting after the oldest drop off. A replay that lands before a newer lap gets a 0 split.
 */
export function lapStopwatch(watch: StopwatchState, now: number): StopwatchState {
  if (watch.status !== 'running') return watch
  const totalMs = Math.round(stopwatchElapsed(watch, now))
  const previous = watch.laps[0]
  const lap = {
    n: (previous?.n ?? 0) + 1,
    totalMs,
    splitMs: Math.max(0, totalMs - (previous?.totalMs ?? 0))
  }
  return { ...watch, laps: [lap, ...watch.laps].slice(0, STOPWATCH_MAX_LAPS) }
}

/** Links the stopwatch to a task (null: to none). */
export function linkStopwatchTask(watch: StopwatchState, taskId: string | null): StopwatchState {
  if ((watch.linkedTaskId ?? null) === taskId) return watch
  const next = { ...watch }
  if (taskId === null) delete next.linkedTaskId
  else next.linkedTaskId = taskId
  return next
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** `h:mm:ss.t`: hours, minutes, seconds and tenths (rounded down), never negative. */
export function formatStopwatch(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100)
  const seconds = Math.floor(tenths / 10)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}:${pad(minutes)}:${pad(seconds % 60)}.${tenths % 10}`
}
