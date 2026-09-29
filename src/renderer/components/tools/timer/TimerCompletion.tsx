import { useCallback, useEffect, useRef } from 'react'
import { useSettingsStore } from '../../../stores/settings'
import { useTasksStore } from '../../../stores/tasks'
import { timerController } from '../../../stores/timer'
import { announceTimerFinished } from './timer-alerts'
import { useTimerTick } from './useTimerTick'

export interface TimerCompletionProps {
  /**
   * This window finishes the timer and raises the alerts: the primary display's window, the
   * single writer (like reconcile), so a countdown chimes and notifies once, not once per monitor.
   */
  leader: boolean
}

/**
 * Watches the countdown in the leader window, whether or not the widget is shown: when
 * tasks.json first loads, a timer that ended while Taskyard was closed becomes "finished while
 * you were away" (no alerts); afterwards a running timer that reaches zero is finished and
 * announced (the Windows notification or else the in-app toast, and the chime, per Settings).
 * Renders nothing.
 */
export function TimerCompletion({ leader }: TimerCompletionProps): null {
  const timer = useTasksStore((state) => state.timer)
  const hydrated = useTasksStore((state) => state.hydrated)
  const checkedAway = useRef(false)

  useEffect(() => {
    if (!leader || !hydrated || checkedAway.current) return
    checkedAway.current = true
    timerController.hydrate()
  }, [leader, hydrated])

  const onTick = useCallback(() => {
    if (!leader || !checkedAway.current) return
    const due = timerController.current()
    if (!timerController.finishIfDue()) return
    const task = useTasksStore.getState().tasks.find((entry) => entry.id === due.linkedTaskId)
    announceTimerFinished(
      { endsAt: due.endsAt ?? Date.now(), ...(task ? { task } : {}) },
      useSettingsStore.getState().settings
    )
  }, [leader])

  useTimerTick(timer, onTick)
  return null
}
