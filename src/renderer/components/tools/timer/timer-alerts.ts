import type { SettingsFile, Task } from '@shared/schema'
import { getBridge } from '../../../lib/bridge'
import { useTasksStore } from '../../../stores/tasks'
import { useUiStore } from '../../../stores/ui'
import { playChime } from './chime'

/** The finished-timer toast stays this long (ms). */
export const TIMER_TOAST_MS = 10_000
export const TIMER_TOAST_ID = 'timer-finished'

export interface FinishedTimer {
  /** The countdown's `endsAt` (main shows one Windows notification per countdown). */
  endsAt: number
  /** The task the timer was focused on, if any. */
  task?: Task
}

/** "Time's up for "Write report"." — the toast's (and the notification's) line. */
export function finishedDescription(task?: Pick<Task, 'text'>): string | undefined {
  return task ? `Time’s up for “${task.text}”.` : undefined
}

/**
 * A countdown just reached zero while Taskyard was running: the toast (with "Mark done" for an
 * open linked task), the Windows notification when Settings › timerNotify, and the chime when
 * Settings › timerSound. Only the leader window calls this (TimerCompletion), so it happens once.
 */
export function announceTimerFinished(
  { endsAt, task }: FinishedTimer,
  settings: Pick<SettingsFile, 'timerNotify' | 'timerSound'>
): void {
  const description = finishedDescription(task)
  useUiStore.getState().pushToast({
    id: TIMER_TOAST_ID,
    message: 'Timer finished',
    ...(description ? { description } : {}),
    tone: 'success',
    durationMs: TIMER_TOAST_MS,
    ...(task && !task.done
      ? {
          action: {
            label: 'Mark done',
            onAction: () => {
              const current = useTasksStore.getState().tasks.find((entry) => entry.id === task.id)
              if (current && !current.done) useTasksStore.getState().toggle(task.id)
            }
          }
        }
      : {})
  })

  if (settings.timerNotify) {
    getBridge()
      .timer.notify({ endsAt, ...(task ? { taskText: task.text } : {}) })
      .catch((error: unknown) => console.error('timer: the Windows notification failed', error))
  }
  if (settings.timerSound) void playChime()
}
