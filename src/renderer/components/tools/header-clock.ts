import type { StopwatchState, TimerState } from '@shared/schema'
import type { ToolId } from './tools-geometry'

const inProgress = (status: string): boolean => status === 'running' || status === 'paused'

/**
 * Which clock the widget's header shows, if any. The countdown's time left shows whenever a
 * countdown is in progress and the Timer tool is not on screen (rolled up, or another tab).
 * Round 2: rolled up on the Stopwatch tab, the stopwatch's time shows instead — unless a
 * countdown is in progress, which keeps priority.
 */
export function headerClockFor(
  activeTool: ToolId,
  rolledUp: boolean,
  timer: Pick<TimerState, 'status'>,
  stopwatch: Pick<StopwatchState, 'status'>
): 'timer' | 'stopwatch' | null {
  if (inProgress(timer.status) && (rolledUp || activeTool !== 'timer')) return 'timer'
  if (rolledUp && activeTool === 'stopwatch' && inProgress(stopwatch.status)) return 'stopwatch'
  return null
}
