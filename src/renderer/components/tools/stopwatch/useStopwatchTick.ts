import { useEffect, useState } from 'react'
import type { StopwatchState } from '@shared/schema'
import { stopwatchElapsed } from '@shared/stopwatch-state'
import { useTasksStore } from '../../../stores/tasks'

/** How often a running stopwatch re-reads the clock (ms): twice per tenth shown. */
export const STOPWATCH_TICK_MS = 50

/**
 * The stopwatch's elapsed time, re-read every 50 ms while it runs. Like the timer's tick
 * (useTimerTick.ts) it is always computed from the absolute `startedAt`, never by counting ticks,
 * and the clock is re-read whenever the stopwatch changes (here or in another window).
 */
export function useStopwatchTick(stopwatch: StopwatchState): number {
  const [now, setNow] = useState(() => Date.now())
  const running = stopwatch.status === 'running'

  useEffect(
    () =>
      useTasksStore.subscribe((state, previous) => {
        if (state.stopwatch !== previous.stopwatch) setNow(Date.now())
      }),
    []
  )

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setNow(Date.now()), STOPWATCH_TICK_MS)
    return () => window.clearInterval(id)
  }, [running])

  return stopwatchElapsed(stopwatch, now)
}
