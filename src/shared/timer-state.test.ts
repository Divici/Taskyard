import { describe, expect, it } from 'vitest'
import { defaultTimer } from './defaults'
import type { TimerState } from './schema'
import { TasksFileSchema } from './schema'
import {
  acknowledgeTimer,
  finishTimer,
  formatClock,
  isTimerDue,
  linkTimerTask,
  pauseTimer,
  resumeTimer,
  setTimerDuration,
  startTimer,
  stopTimer,
  TIMER_MAX_MS,
  TIMER_MIN_MS,
  timerRemaining
} from './timer-state'

const NOW = 1_000_000
const idle = (patch: Partial<TimerState> = {}): TimerState => ({ ...defaultTimer(), ...patch })
const running = (endsAt: number, patch: Partial<TimerState> = {}): TimerState =>
  idle({ status: 'running', endsAt, ...patch })

describe('timer state', () => {
  it('start stores an absolute endsAt from the chosen duration', () => {
    const started = startTimer(idle({ durationMs: 120_000 }), NOW)

    expect(started).toMatchObject({ status: 'running', endsAt: NOW + 120_000 })
    expect(timerRemaining(started, NOW + 30_000)).toBe(90_000)
  })

  it('start restarts a finished timer and forgets the away note', () => {
    const finished = idle({ status: 'finished', finishedAway: true })

    const started = startTimer(finished, NOW)

    expect(started.status).toBe('running')
    expect(started.finishedAway).toBeUndefined()
  })

  it('start leaves a running or paused timer alone', () => {
    const run = running(NOW + 5_000)
    const paused = idle({ status: 'paused', remainingMs: 4_000 })

    expect(startTimer(run, NOW)).toBe(run)
    expect(startTimer(paused, NOW)).toBe(paused)
  })

  it('pause freezes the remaining time; resume continues from it', () => {
    const paused = pauseTimer(running(NOW + 90_000), NOW)
    expect(paused).toEqual(idle({ status: 'paused', remainingMs: 90_000 }))
    expect(timerRemaining(paused, NOW + 60_000)).toBe(90_000)

    const resumed = resumeTimer(paused, NOW + 60_000)
    expect(resumed).toEqual(running(NOW + 150_000))
    expect(timerRemaining(resumed, NOW + 60_000)).toBe(90_000)
  })

  it('pause and resume are no-ops in the wrong state', () => {
    const base = idle()
    expect(pauseTimer(base, NOW)).toBe(base)
    expect(resumeTimer(base, NOW)).toBe(base)
  })

  it('stop resets to the chosen duration, keeping the linked task', () => {
    const stopped = stopTimer(running(NOW + 5_000, { durationMs: 300_000, linkedTaskId: 't' }))

    expect(stopped).toEqual(idle({ durationMs: 300_000, linkedTaskId: 't' }))
    expect(timerRemaining(stopped, NOW)).toBe(300_000)
  })

  it('remaining never goes negative', () => {
    expect(timerRemaining(running(NOW - 10_000), NOW)).toBe(0)
    expect(timerRemaining(idle({ status: 'finished' }), NOW)).toBe(0)
  })

  it('setDuration accepts whole minutes from 1 to 180 while idle or finished', () => {
    expect(setTimerDuration(idle(), 15 * 60_000).durationMs).toBe(900_000)
    expect(setTimerDuration(idle({ status: 'finished' }), TIMER_MIN_MS)).toEqual(
      idle({ durationMs: TIMER_MIN_MS })
    )
    const base = idle()
    expect(setTimerDuration(base, 0)).toBe(base)
    expect(setTimerDuration(base, TIMER_MAX_MS + 60_000)).toBe(base)
    expect(setTimerDuration(base, 1.5)).toBe(base)
    const run = running(NOW + 1)
    expect(setTimerDuration(run, 60_000)).toBe(run)
  })

  it('finish turns a due running timer into finished (optionally noting the absence)', () => {
    expect(isTimerDue(running(NOW), NOW)).toBe(true)
    expect(isTimerDue(running(NOW + 1), NOW)).toBe(false)

    expect(finishTimer(running(NOW - 1, { linkedTaskId: 't' }), NOW)).toEqual(
      idle({ status: 'finished', linkedTaskId: 't' })
    )
    expect(finishTimer(running(NOW - 1), NOW, { away: true })).toEqual(
      idle({ status: 'finished', finishedAway: true })
    )
    const early = running(NOW + 1)
    expect(finishTimer(early, NOW)).toBe(early)
  })

  it('acknowledge returns a finished timer to idle', () => {
    expect(acknowledgeTimer(idle({ status: 'finished', finishedAway: true }))).toEqual(idle())
    const run = running(NOW)
    expect(acknowledgeTimer(run)).toBe(run)
  })

  it('linkTask sets and clears the focused task', () => {
    expect(linkTimerTask(idle(), 't-1').linkedTaskId).toBe('t-1')
    expect(linkTimerTask(idle({ linkedTaskId: 't-1' }), null)).toEqual(idle())
    const same = idle({ linkedTaskId: 't-1' })
    expect(linkTimerTask(same, 't-1')).toBe(same)
  })

  it('every state it produces is a valid tasks.json timer', () => {
    const states = [
      startTimer(idle(), NOW),
      pauseTimer(running(NOW + 5), NOW),
      finishTimer(running(NOW), NOW, { away: true }),
      stopTimer(running(NOW))
    ]
    for (const timer of states) {
      expect(TasksFileSchema.safeParse({ version: 1, tasks: [], timer }).success).toBe(true)
    }
  })

  it('formats mm:ss, h:mm:ss past an hour, rounding up to whole seconds', () => {
    expect(formatClock(25 * 60_000)).toBe('25:00')
    expect(formatClock(59_001)).toBe('01:00')
    expect(formatClock(754_000)).toBe('12:34')
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(-5)).toBe('00:00')
    expect(formatClock(60 * 60_000)).toBe('60:00')
    expect(formatClock(60 * 60_000 + 1_000)).toBe('1:00:01')
    expect(formatClock(180 * 60_000)).toBe('3:00:00')
  })
})
