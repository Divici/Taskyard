import type { StopwatchState, TimerState } from '@shared/schema'
import { formatStopwatch } from '@shared/stopwatch-state'
import { formatClock } from '@shared/timer-state'
import { cn } from '../../lib/utils'
import { useStopwatchTick } from './stopwatch/useStopwatchTick'
import { useTimerTick } from './timer/useTimerTick'

const PILL = cn(
  'shrink-0 rounded-full px-2 py-0.5 text-[12px] font-semibold text-accent-1 tabular-nums',
  'bg-accent-1/10 shadow-[0_0_10px_color-mix(in_srgb,var(--accent-1)_30%,transparent)]'
)

/** The countdown's time left in the header (it ticks on its own). */
export function TimerHeaderClock({ timer }: { timer: TimerState }): React.JSX.Element {
  const remaining = useTimerTick(timer)
  return (
    <span
      role="timer"
      aria-live="off"
      aria-label="Time left"
      className={cn(PILL, timer.status === 'paused' && 'opacity-60')}
    >
      {formatClock(remaining)}
    </span>
  )
}

/** Round 2: the stopwatch's elapsed time in the header (it ticks on its own). */
export function StopwatchHeaderClock({
  stopwatch
}: {
  stopwatch: StopwatchState
}): React.JSX.Element {
  const elapsed = useStopwatchTick(stopwatch)
  return (
    <span
      role="timer"
      aria-live="off"
      aria-label="Elapsed time"
      className={cn(PILL, stopwatch.status === 'paused' && 'opacity-60')}
    >
      {formatStopwatch(elapsed)}
    </span>
  )
}
