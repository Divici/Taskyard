import type { StoreApi } from 'zustand'
import type { TimerState } from '@shared/schema'
import {
  acknowledgeTimer,
  finishTimer,
  isTimerDue,
  isValidDuration,
  linkTimerTask,
  pauseTimer,
  resumeTimer,
  setTimerDuration,
  startTimer,
  stopTimer,
  timerRemaining
} from '@shared/timer-state'
import { useTasksStore, type TasksState } from './tasks'

/**
 * The countdown timer's actions (Phase 10). The timer's data is tasks.json's `timer`, held by the
 * tasks store, so this is a controller over it rather than a second store: every action is a
 * pure transition (src/shared/timer-state.ts) applied with `updateTimer` to the timer as it is
 * when applied, and the clock is read once, when the action is called (a replay on newer data
 * keeps that moment). States: `idle | running {endsAt} | paused {remainingMs} | finished`.
 */
export interface TimerController {
  /** The timer as the tasks store holds it now. */
  current(): TimerState
  /** Milliseconds left now (recomputed from `endsAt`, never negative). */
  remaining(): number
  /** Whole minutes 1–180, while idle or finished; false (nothing changes) otherwise. */
  setDuration(ms: number): boolean
  start(): void
  pause(): void
  resume(): void
  /** Resets to the chosen duration. */
  stop(): void
  /** Focuses the timer on a task, or on none (null). Deleting the task clears it. */
  linkTask(taskId: string | null): void
  /** Dismisses the finished state (back to idle). */
  acknowledge(): void
  /**
   * Call once when tasks.json has loaded: a timer that ended while Taskyard was closed becomes
   * `finished` with the "finished while you were away" note (no chime, no notification).
   * Returns whether that happened.
   */
  hydrate(): boolean
  /** A running timer whose time has come becomes `finished`; true when it did (fire the alerts). */
  finishIfDue(): boolean
}

export interface TimerControllerOptions {
  tasks?: Pick<StoreApi<TasksState>, 'getState'>
  now?: () => number
}

export function createTimerController({
  tasks = useTasksStore,
  // Looked up on every call (never captured), so a faked clock in tests is honoured.
  now = () => Date.now()
}: TimerControllerOptions = {}): TimerController {
  const current = (): TimerState => tasks.getState().timer
  const apply = (update: (timer: TimerState) => TimerState): void =>
    tasks.getState().updateTimer(update)

  /** Finishes the timer if it is due now; the change is saved like any other. */
  const finish = (away: boolean): boolean => {
    const at = now()
    if (!isTimerDue(current(), at)) return false
    apply((timer) => finishTimer(timer, at, { away }))
    return true
  }

  return {
    current,
    remaining: () => timerRemaining(current(), now()),
    setDuration(ms) {
      const timer = current()
      if (!isValidDuration(ms) || timer.status === 'running' || timer.status === 'paused') {
        return false
      }
      apply((latest) => setTimerDuration(latest, ms))
      return true
    },
    start() {
      const at = now()
      apply((timer) => startTimer(timer, at))
    },
    pause() {
      const at = now()
      apply((timer) => pauseTimer(timer, at))
    },
    resume() {
      const at = now()
      apply((timer) => resumeTimer(timer, at))
    },
    stop: () => apply(stopTimer),
    linkTask: (taskId) => apply((timer) => linkTimerTask(timer, taskId)),
    acknowledge: () => apply(acknowledgeTimer),
    hydrate: () => finish(true),
    finishIfDue: () => finish(false)
  }
}

/** The app's timer, over the app's tasks store. */
export const timerController = createTimerController()
