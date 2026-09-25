import { useEffect, useState } from 'react'
import type { TimerState } from '@shared/schema'
import { timerRemaining } from '@shared/timer-state'
import { useTasksStore } from '../../../stores/tasks'

/** How often a running countdown re-reads the clock (ms). */
export const TICK_MS = 250

/**
 * The time left on `timer`, re-read every 250 ms while it runs. It is always computed from the
 * absolute `endsAt` (never by counting ticks), so it cannot drift and is right after sleep.
 * The clock is also re-read whenever the timer changes (start, resume, another window's save),
 * so the first frame after a change is already right. `onTick` runs on every tick.
 */
export function useTimerTick(timer: TimerState, onTick?: () => void): number {
  const [now, setNow] = useState(() => Date.now())
  const running = timer.status === 'running'

  useEffect(
    () =>
      useTasksStore.subscribe((state, previous) => {
        if (state.timer !== previous.timer) setNow(Date.now())
      }),
    []
  )

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => {
      setNow(Date.now())
      onTick?.()
    }, TICK_MS)
    return () => window.clearInterval(id)
  }, [running, onTick])

  return timerRemaining(timer, now)
}
