import { Check, Pause, Play, Square, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { TIMER_MAX_MS, TIMER_MIN_MS, formatClock, timerRemaining } from '@shared/timer-state'
import { cn } from '../../../lib/utils'
import { useTasksStore } from '../../../stores/tasks'
import { timerController } from '../../../stores/timer'
import { useUiStore } from '../../../stores/ui'
import { FocusLine, TaskPicker } from '../TaskFocus'
import { splitTasks } from '../todo/task-lists'
import {
  FIELD,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  SPACE_OWNERS,
  TOOL_COLUMN,
  TOOL_ROW
} from '../tool-styles'
import { ProgressRing } from './ProgressRing'
import { useTimerTick } from './useTimerTick'

const MINUTE = 60_000
/** Controls where Esc already means something (clear/close); everywhere else it asks to stop. */
const ESC_OWNERS = 'input, select, textarea, [contenteditable]'
const CUSTOM_HINT = 'Enter a whole number of minutes from 1 to 180.'
/** Announced once when the countdown passes this much time left. */
const LAST_MINUTE_MS = MINUTE

const store = (): ReturnType<typeof useTasksStore.getState> => useTasksStore.getState()

/**
 * Round 2: the finished countdown's action for its linked task, derived from the task's current
 * `done` (so it follows an uncheck in the Tasks tool or another window). It sets the state it
 * shows rather than toggling, so a stale click can never flip the task back.
 */
function LinkedTaskAction({ id, done }: { id: string; done: boolean }): React.JSX.Element {
  if (!done) {
    return (
      <button type="button" onClick={() => store().setDone(id, true)} className={SECONDARY_BUTTON}>
        <Check aria-hidden="true" className="size-3.5" />
        Mark done
      </button>
    )
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-[12px] font-semibold text-accent-1">Done ✓</span>
      <button type="button" onClick={() => store().setDone(id, false)} className={SECONDARY_BUTTON}>
        <Undo2 aria-hidden="true" className="size-3.5" />
        Undo
      </button>
    </span>
  )
}

/**
 * The countdown timer: a large `mm:ss` (`h:mm:ss` past an hour) centred in the accent progress
 * ring with a short state caption under it, the linked task on one line under the ring, Start ·
 * Pause/Resume · Stop, presets 5/15/25/45 min and a custom 1–180 minutes field (both locked while
 * a countdown is in progress), and "Focus on…" to link an active task — all on one centre line.
 * When a countdown with a linked task has finished, the inline action follows that task's state:
 * "Mark done" while it is open, "Done ✓ · Undo" once it is done (round 2). Space toggles
 * Start/Pause and Esc (running) asks before stopping, while the view has focus. The display is a
 * `role="timer"` that is not live; a separate polite region says "1 minute left" and "Timer
 * finished".
 */
export function TimerTool(): React.JSX.Element {
  const timer = useTasksStore((state) => state.timer)
  const tasks = useTasksStore((state) => state.tasks)
  const [announcement, setAnnouncement] = useState('')
  // Polite announcement once a minute is left: checked on every tick (never on render).
  const lastRemaining = useRef<number | null>(null)
  const onTick = useCallback(() => {
    const current = useTasksStore.getState().timer
    const left = timerRemaining(current, Date.now())
    const before = lastRemaining.current
    lastRemaining.current = left
    if (before !== null && before > LAST_MINUTE_MS && left <= LAST_MINUTE_MS && left > 0) {
      setAnnouncement('1 minute left')
    }
  }, [])
  const remaining = useTimerTick(timer, onTick)
  const active = useMemo(() => splitTasks(tasks).active, [tasks])
  const linked = tasks.find((task) => task.id === timer.linkedTaskId)
  const [custom, setCustom] = useState(String(timer.durationMs / MINUTE))
  const [customInvalid, setCustomInvalid] = useState(false)
  const hintId = useId()
  const customId = useId()

  const counting = timer.status === 'running' || timer.status === 'paused'
  const finished = timer.status === 'finished'

  // Following the timer as it changes (here, or in another window): the custom field shows the
  // chosen duration, and the end of a countdown is announced.
  useEffect(
    () =>
      useTasksStore.subscribe(({ timer: next }, { timer: before }) => {
        if (next.durationMs !== before.durationMs) {
          setCustom(String(next.durationMs / MINUTE))
          setCustomInvalid(false)
        }
        if (next.status !== before.status) {
          lastRemaining.current = null
          if (next.status === 'finished' && !next.finishedAway) setAnnouncement('Timer finished')
          else if (next.status === 'idle') setAnnouncement('')
        }
      }),
    []
  )

  const primary = (): void => {
    if (timer.status === 'running') timerController.pause()
    else if (timer.status === 'paused') timerController.resume()
    else timerController.start()
  }

  const applyCustom = (): void => {
    const minutes = Number(custom)
    const ms = minutes * MINUTE
    const valid =
      custom.trim() !== '' && Number.isInteger(minutes) && ms >= TIMER_MIN_MS && ms <= TIMER_MAX_MS
    setCustomInvalid(!valid)
    if (valid) timerController.setDuration(ms)
  }

  const confirmStop = async (): Promise<void> => {
    const ok = await useUiStore.getState().confirm({
      title: 'Stop the timer?',
      description: `The countdown resets to ${formatClock(timer.durationMs)}.`,
      confirmLabel: 'Stop timer',
      destructive: true
    })
    if (ok) timerController.stop()
  }

  // Inside the ring, under the clock: one short word or two.
  const caption = finished
    ? 'Time’s up'
    : timer.status === 'paused'
      ? 'Paused'
      : timer.status === 'running'
        ? 'Running'
        : 'Ready'

  const progress = timer.durationMs > 0 ? remaining / timer.durationMs : 0

  return (
    <div
      role="group"
      aria-label="Timer"
      // In the Tab order, so keyboard users can reach Space/Esc on the view itself.
      tabIndex={0}
      onKeyDown={(event) => {
        const target = event.target as Element
        if (event.key === ' ') {
          // Space on a control belongs to that control (a button presses itself).
          if (target.closest(SPACE_OWNERS)) return
          event.preventDefault()
          primary()
        } else if (
          event.key === 'Escape' &&
          timer.status === 'running' &&
          // Esc has its own meaning in a text field or an open picker.
          !target.closest(ESC_OWNERS)
        ) {
          event.preventDefault()
          event.stopPropagation()
          void confirmStop()
        }
      }}
      className={TOOL_COLUMN}
    >
      <ProgressRing
        progress={progress}
        finished={finished}
        paused={timer.status === 'paused'}
        caption={caption}
      >
        <div
          role="timer"
          aria-live="off"
          aria-label="Time left"
          className={cn(
            'font-light tracking-tight text-text-primary tabular-nums',
            remaining >= 3_600_000 ? 'text-[26px]' : 'text-[34px]',
            finished && 'text-accent-1'
          )}
        >
          {formatClock(remaining)}
        </div>
      </ProgressRing>

      {finished && timer.finishedAway && (
        <p className="shrink-0 text-center text-[11px] leading-4 text-text-tertiary">
          Finished while you were away
        </p>
      )}
      <FocusLine task={linked} />

      <div className={cn(TOOL_ROW, 'flex flex-wrap items-center justify-center gap-2')}>
        <button
          type="button"
          onClick={primary}
          className={PRIMARY_BUTTON}
          aria-label={
            timer.status === 'running' ? 'Pause' : timer.status === 'paused' ? 'Resume' : 'Start'
          }
        >
          {timer.status === 'running' ? (
            <Pause aria-hidden="true" className="size-3.5" />
          ) : (
            <Play aria-hidden="true" className="size-3.5" />
          )}
          {timer.status === 'running' ? 'Pause' : timer.status === 'paused' ? 'Resume' : 'Start'}
        </button>
        <button
          type="button"
          onClick={() => timerController.stop()}
          disabled={timer.status === 'idle'}
          className={SECONDARY_BUTTON}
          aria-label="Stop"
        >
          <Square aria-hidden="true" className="size-3" />
          Stop
        </button>
        {finished && linked && <LinkedTaskAction id={linked.id} done={linked.done} />}
      </div>

      <div
        role="group"
        aria-label="Presets"
        className={cn(TOOL_ROW, 'flex flex-wrap items-center justify-center gap-1.5')}
      >
        {timer.presetsMs.map((ms) => (
          <button
            key={ms}
            type="button"
            aria-pressed={!counting && timer.durationMs === ms}
            disabled={counting}
            onClick={() => timerController.setDuration(ms)}
            className={cn(
              'h-7 rounded-full border px-2.5 text-[11px] font-medium transition-[background-color,border-color,color,box-shadow] duration-[180ms] focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:outline-none disabled:opacity-40',
              !counting && timer.durationMs === ms
                ? 'border-accent-1/70 bg-accent-1/15 text-accent-1 shadow-[0_0_10px_color-mix(in_srgb,var(--accent-1)_35%,transparent)]'
                : 'border-white/10 text-text-secondary hover:border-accent-1/40 hover:text-text-primary [[data-theme=light]_&]:border-black/10'
            )}
          >
            {ms / MINUTE} min
          </button>
        ))}
      </div>

      <div
        data-timer-fields=""
        className={cn(TOOL_ROW, 'flex flex-col gap-1.5 text-[11px] text-text-secondary')}
      >
        <div className="flex items-center gap-2">
          <label htmlFor={customId} className="w-16 shrink-0">
            Custom
          </label>
          <input
            id={customId}
            type="number"
            inputMode="numeric"
            aria-label="Custom minutes"
            min={1}
            max={180}
            step={1}
            value={custom}
            disabled={counting}
            aria-invalid={customInvalid || undefined}
            aria-describedby={customInvalid ? hintId : undefined}
            onChange={(event) => {
              setCustom(event.target.value)
              setCustomInvalid(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                applyCustom()
              }
            }}
            onBlur={applyCustom}
            className={cn(FIELD, 'w-16', customInvalid && 'border-red-400/80')}
          />
          <span aria-hidden="true">min</span>
        </div>
        {customInvalid && (
          <p id={hintId} className="text-[11px] text-red-300 [[data-theme=light]_&]:text-red-700">
            {CUSTOM_HINT}
          </p>
        )}
        <TaskPicker
          active={active}
          linked={linked}
          onLink={(taskId) => timerController.linkTask(taskId)}
        />
      </div>

      <div data-testid="timer-announcer" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
