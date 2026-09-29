import type { SettingsFile, Task } from '@shared/schema'
import { getBridge } from '../../../lib/bridge'
import { useTasksStore } from '../../../stores/tasks'
import { useUiStore } from '../../../stores/ui'
import { playChime } from './chime'

/** The in-app finished-timer toast (timerNotify off, or Windows could not notify) stays this long (ms). */
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

/** The in-app "Timer finished" toast, with "Mark done" for an open linked task. */
function pushFinishedToast(task: Task | undefined): void {
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
            // Sets done (never toggles): a task completed meanwhile stays completed.
            onAction: () => useTasksStore.getState().setDone(task.id, true)
          }
        }
      : {})
  })
}

/**
 * A countdown just reached zero while Taskyard was running. Round 2: one pop-up, not two — the
 * Windows notification when Settings › timerNotify (bottom-right, by the clock), otherwise the
 * in-app toast; the toast also stands in when Windows could not show the notification. The
 * chime plays when Settings › timerSound; the widget's ring pulse and its inline "Mark done"
 * need nothing from here. Only the leader window calls this (TimerCompletion), so it happens once.
 */
export function announceTimerFinished(
  { endsAt, task }: FinishedTimer,
  settings: Pick<SettingsFile, 'timerNotify' | 'timerSound'>
): void {
  if (settings.timerNotify) {
    getBridge()
      .timer.notify({ endsAt, ...(task ? { taskText: task.text } : {}) })
      .then((shown) => {
        if (!shown) pushFinishedToast(task)
      })
      .catch((error: unknown) => {
        console.error('timer: the Windows notification failed', error)
        pushFinishedToast(task)
      })
  } else {
    pushFinishedToast(task)
  }
  if (settings.timerSound) void playChime()
}
