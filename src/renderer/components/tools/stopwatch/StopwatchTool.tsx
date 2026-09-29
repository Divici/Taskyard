import { Flag, Pause, Play, RotateCcw } from 'lucide-react'
import { useMemo } from 'react'
import { formatStopwatch } from '@shared/stopwatch-state'
import { cn } from '../../../lib/utils'
import { stopwatchController } from '../../../stores/stopwatch'
import { useTasksStore } from '../../../stores/tasks'
import { FocusLine, TaskPicker } from '../TaskFocus'
import { ProgressRing } from '../timer/ProgressRing'
import { splitTasks } from '../todo/task-lists'
import {
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  SPACE_OWNERS,
  TOOL_COLUMN,
  TOOL_ROW,
  TOOL_VIEW
} from '../tool-styles'
import { useStopwatchTick } from './useStopwatchTick'

const MINUTE = 60_000

/** `h:mm:ss` large with the tenths smaller beside it, sized to fit inside the ring. */
function ElapsedClock({ ms }: { ms: number }): React.JSX.Element {
  const text = formatStopwatch(ms)
  const dot = text.lastIndexOf('.')
  return (
    <div
      role="timer"
      aria-live="off"
      aria-label="Elapsed time"
      className={cn(
        'font-light tracking-tight text-text-primary tabular-nums',
        text.length > 9 ? 'text-[19px]' : 'text-[22px]'
      )}
    >
      {text.slice(0, dot)}
      <span className="text-[0.65em] text-text-secondary">{text.slice(dot)}</span>
    </div>
  )
}

/**
 * The stopwatch (round 2): a large `h:mm:ss.t` inside the accent ring (its arc sweeps once a
 * minute), Start · Pause/Resume, Lap and Reset, "Focus on…" to link an active task, and the laps
 * (newest first, at most 50) with each lap's split and total. It counts up from an absolute
 * `startedAt`, so it keeps running across restarts. Space toggles Start/Pause while the view has
 * focus. The display is a `role="timer"` that is not live. The view scrolls and its content is
 * one block, centred while shorter than the view and from the top once taller (2026-09-29).
 */
export function StopwatchTool(): React.JSX.Element {
  const stopwatch = useTasksStore((state) => state.stopwatch)
  const tasks = useTasksStore((state) => state.tasks)
  const elapsed = useStopwatchTick(stopwatch)
  const active = useMemo(() => splitTasks(tasks).active, [tasks])
  const linked = tasks.find((task) => task.id === stopwatch.linkedTaskId)

  const { status } = stopwatch
  const primaryLabel = status === 'running' ? 'Pause' : status === 'paused' ? 'Resume' : 'Start'
  const caption = status === 'running' ? 'Running' : status === 'paused' ? 'Paused' : 'Ready'

  return (
    <div
      role="group"
      aria-label="Stopwatch"
      // In the Tab order, so keyboard users can reach the Space shortcut on the view itself.
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== ' ') return
        // Space on a control belongs to that control (a button presses itself).
        if ((event.target as Element).closest(SPACE_OWNERS)) return
        event.preventDefault()
        stopwatchController.toggle()
      }}
      data-tool-body=""
      className={TOOL_VIEW}
    >
      <div data-tool-content="" className={TOOL_COLUMN}>
        <ProgressRing
          progress={(elapsed % MINUTE) / MINUTE}
          finished={false}
          paused={status === 'paused'}
          caption={caption}
          animate={false}
          testId="stopwatch-ring"
        >
          <ElapsedClock ms={elapsed} />
        </ProgressRing>

        <FocusLine task={linked} />

        <div className={cn(TOOL_ROW, 'flex flex-wrap items-center justify-center gap-2')}>
          <button
            type="button"
            onClick={() => stopwatchController.toggle()}
            className={PRIMARY_BUTTON}
          >
            {status === 'running' ? (
              <Pause aria-hidden="true" className="size-3.5" />
            ) : (
              <Play aria-hidden="true" className="size-3.5" />
            )}
            {primaryLabel}
          </button>
          <button
            type="button"
            onClick={() => stopwatchController.lap()}
            disabled={status !== 'running'}
            className={SECONDARY_BUTTON}
          >
            <Flag aria-hidden="true" className="size-3.5" />
            Lap
          </button>
          <button
            type="button"
            onClick={() => stopwatchController.reset()}
            disabled={status === 'idle'}
            className={SECONDARY_BUTTON}
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            Reset
          </button>
        </div>

        <div className={TOOL_ROW}>
          <TaskPicker
            active={active}
            linked={linked}
            onLink={(taskId) => stopwatchController.linkTask(taskId)}
          />
        </div>

        {stopwatch.laps.length > 0 && (
          <div className={cn(TOOL_ROW, 'flex shrink-0 flex-col gap-1')}>
            <div
              aria-hidden="true"
              className="grid grid-cols-[3.5rem_1fr_1fr] gap-2 px-2.5 text-[10px] font-semibold tracking-wide text-text-tertiary uppercase"
            >
              <span>Lap</span>
              <span className="text-right">Split</span>
              <span className="text-right">Total</span>
            </div>
            <ol
              aria-label="Laps"
              className={cn(
                'flex flex-col divide-y divide-white/5 rounded-[10px] border border-white/10 bg-black/15 px-2.5 text-[12px] tabular-nums',
                '[[data-theme=light]_&]:divide-black/5 [[data-theme=light]_&]:border-black/10 [[data-theme=light]_&]:bg-white/40'
              )}
            >
              {stopwatch.laps.map((lap) => (
                <li
                  key={lap.n}
                  aria-label={`Lap ${lap.n}: split ${formatStopwatch(lap.splitMs)}, total ${formatStopwatch(lap.totalMs)}`}
                  className="grid grid-cols-[3.5rem_1fr_1fr] items-center gap-2 py-1.5"
                >
                  <span className="text-text-tertiary">Lap {lap.n}</span>
                  <span className="text-right text-text-primary">
                    {formatStopwatch(lap.splitMs)}
                  </span>
                  <span className="text-right text-text-secondary">
                    {formatStopwatch(lap.totalMs)}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  )
}
