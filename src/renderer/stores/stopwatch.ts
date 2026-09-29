import type { StoreApi } from 'zustand'
import type { StopwatchState } from '@shared/schema'
import {
  lapStopwatch,
  linkStopwatchTask,
  pauseStopwatch,
  resetStopwatch,
  resumeStopwatch,
  startStopwatch,
  stopwatchElapsed
} from '@shared/stopwatch-state'
import { useTasksStore, type TasksState } from './tasks'

/**
 * The stopwatch's actions (round 2), a controller over tasks.json's `stopwatch` like the timer's
 * (stores/timer.ts): every action is a pure transition (src/shared/stopwatch-state.ts) applied
 * with `updateStopwatch`, and the clock is read once, when the action is called, so a replay on
 * newer data keeps that moment. States: `idle | running {startedAt} | paused`.
 */
export interface StopwatchController {
  /** The stopwatch as the tasks store holds it now. */
  current(): StopwatchState
  /** Elapsed milliseconds now. */
  elapsed(): number
  start(): void
  pause(): void
  resume(): void
  /** Start, Pause or Resume, whichever applies (the Space shortcut and the primary button). */
  toggle(): void
  /** Records a lap while running. */
  lap(): void
  /** Back to zero with no laps. */
  reset(): void
  /** Links the stopwatch to a task, or to none (null). Deleting the task clears it. */
  linkTask(taskId: string | null): void
}

export interface StopwatchControllerOptions {
  tasks?: Pick<StoreApi<TasksState>, 'getState'>
  now?: () => number
}

export function createStopwatchController({
  tasks = useTasksStore,
  // Looked up on every call (never captured), so a faked clock in tests is honoured.
  now = () => Date.now()
}: StopwatchControllerOptions = {}): StopwatchController {
  const current = (): StopwatchState => tasks.getState().stopwatch
  const apply = (update: (watch: StopwatchState) => StopwatchState): void =>
    tasks.getState().updateStopwatch(update)
  /** A transition that needs the time, read now. */
  const timed = (transition: (watch: StopwatchState, at: number) => StopwatchState) => () => {
    const at = now()
    apply((watch) => transition(watch, at))
  }

  const start = timed(startStopwatch)
  const pause = timed(pauseStopwatch)
  const resume = timed(resumeStopwatch)

  return {
    current,
    elapsed: () => stopwatchElapsed(current(), now()),
    start,
    pause,
    resume,
    toggle() {
      const { status } = current()
      if (status === 'running') pause()
      else if (status === 'paused') resume()
      else start()
    },
    lap: timed(lapStopwatch),
    reset: () => apply(resetStopwatch),
    linkTask: (taskId) => apply((watch) => linkStopwatchTask(watch, taskId))
  }
}

/** The app's stopwatch, over the app's tasks store. */
export const stopwatchController = createStopwatchController()
