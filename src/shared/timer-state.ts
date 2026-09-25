import type { TimerState } from './schema'

// Pure countdown-timer transitions over tasks.json's `timer` (Phase 10). Each one is an updater
// for `updateTimer` (src/shared/tasks-mutations.ts): it looks only at the timer it receives, so a
// replay on another window's newer data stays correct, and it returns the same object when the
// transition does not apply. A running timer stores an absolute `endsAt` (epoch ms), never a
// countdown, so it survives sleep and restarts without drifting.

/** The custom duration input's range: 1 to 180 whole minutes. */
export const TIMER_MIN_MS = 60_000
export const TIMER_MAX_MS = 180 * 60_000

/** A finished or idle timer without the transient fields of a countdown. */
function withoutCountdown(timer: TimerState): TimerState {
  const next = { ...timer }
  delete next.endsAt
  delete next.remainingMs
  delete next.finishedAway
  return next
}

/** Milliseconds left: the whole duration when idle, the frozen value when paused, 0 when done. */
export function timerRemaining(timer: TimerState, now: number): number {
  switch (timer.status) {
    case 'running':
      return Math.max(0, (timer.endsAt ?? now) - now)
    case 'paused':
      return Math.max(0, timer.remainingMs ?? 0)
    case 'finished':
      return 0
    default:
      return timer.durationMs
  }
}

/** A running timer whose `endsAt` has come. */
export function isTimerDue(timer: TimerState, now: number): boolean {
  return timer.status === 'running' && timer.endsAt !== undefined && timer.endsAt <= now
}

/** Idle or finished → running for the chosen duration. */
export function startTimer(timer: TimerState, now: number): TimerState {
  if (timer.status === 'running' || timer.status === 'paused') return timer
  return { ...withoutCountdown(timer), status: 'running', endsAt: now + timer.durationMs }
}

/** Running → paused, freezing what is left. */
export function pauseTimer(timer: TimerState, now: number): TimerState {
  if (timer.status !== 'running') return timer
  const remainingMs = Math.max(0, Math.round(timerRemaining(timer, now)))
  return { ...withoutCountdown(timer), status: 'paused', remainingMs }
}

/** Paused → running, continuing from the frozen value. */
export function resumeTimer(timer: TimerState, now: number): TimerState {
  if (timer.status !== 'paused') return timer
  return { ...withoutCountdown(timer), status: 'running', endsAt: now + (timer.remainingMs ?? 0) }
}

/** Anything → idle at the chosen duration (the linked task is kept). */
export function stopTimer(timer: TimerState): TimerState {
  if (
    timer.status === 'idle' &&
    timer.endsAt === undefined &&
    timer.remainingMs === undefined &&
    timer.finishedAway === undefined
  ) {
    return timer
  }
  return { ...withoutCountdown(timer), status: 'idle' }
}

/** Whole minutes from 1 to 180 (the schema's cap), accepted while idle or finished. */
export function isValidDuration(ms: number): boolean {
  return Number.isInteger(ms) && ms >= TIMER_MIN_MS && ms <= TIMER_MAX_MS && ms % 60_000 === 0
}

/** Sets the countdown's length; a finished timer goes back to idle with it. */
export function setTimerDuration(timer: TimerState, durationMs: number): TimerState {
  if (timer.status === 'running' || timer.status === 'paused') return timer
  if (!isValidDuration(durationMs)) return timer
  if (timer.status === 'idle' && timer.durationMs === durationMs) return timer
  return { ...withoutCountdown(timer), status: 'idle', durationMs }
}

/** Focuses the timer on a task (null: on none). */
export function linkTimerTask(timer: TimerState, taskId: string | null): TimerState {
  if ((timer.linkedTaskId ?? null) === taskId) return timer
  const next = { ...timer }
  if (taskId === null) delete next.linkedTaskId
  else next.linkedTaskId = taskId
  return next
}

/**
 * A due running timer → finished. `away`: it ended while Taskyard was not running (found due
 * when the data loaded), so the widget says so instead of chiming.
 */
export function finishTimer(
  timer: TimerState,
  now: number,
  options: { away?: boolean } = {}
): TimerState {
  if (!isTimerDue(timer, now)) return timer
  const next: TimerState = { ...withoutCountdown(timer), status: 'finished' }
  if (options.away) next.finishedAway = true
  return next
}

/** Finished → idle (the finished state was seen and dismissed). */
export function acknowledgeTimer(timer: TimerState): TimerState {
  return timer.status === 'finished' ? { ...withoutCountdown(timer), status: 'idle' } : timer
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** `mm:ss`, or `h:mm:ss` past an hour; rounded up to whole seconds, never negative. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (total > 3600) return `${hours}:${pad(minutes)}:${pad(seconds)}`
  return `${pad(Math.floor(total / 60))}:${pad(seconds)}`
}
