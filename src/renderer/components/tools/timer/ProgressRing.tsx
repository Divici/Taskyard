import { cn } from '../../../lib/utils'
import { RING_RADIUS, RING_SIZE, RING_STROKE } from './ring-geometry'

export interface ProgressRingProps {
  /** 0 (nothing left) to 1 (all of it left). */
  progress: number
  /** Pulses (the countdown is over). */
  finished: boolean
  /** Dimmed while paused. */
  paused: boolean
  children: React.ReactNode
}

const SIZE = RING_SIZE
const STROKE = RING_STROKE
const RADIUS = RING_RADIUS
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * The accent progress ring round the countdown (the cyan glow ring of design/taskbarDesign.jpg):
 * a faint track and a glowing arc for the time left, shrinking clockwise from the top. It pulses
 * when the countdown is over.
 */
export function ProgressRing({
  progress,
  finished,
  paused,
  children
}: ProgressRingProps): React.JSX.Element {
  const left = Math.min(1, Math.max(0, progress))
  return (
    <div
      data-testid="timer-ring"
      data-finished={finished || undefined}
      className="relative mx-auto flex shrink-0 items-center justify-center"
      style={{ width: SIZE, height: SIZE }}
    >
      <svg
        aria-hidden="true"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={cn(
          'absolute inset-0 -rotate-90 overflow-visible',
          finished && 'motion-safe:animate-pulse'
        )}
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          className="stroke-white/10 [[data-theme=light]_&]:stroke-black/10"
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={finished ? 0 : CIRCUMFERENCE * (1 - left)}
          className={cn(
            'stroke-accent-1 transition-[stroke-dashoffset,opacity] duration-[250ms] ease-linear',
            paused && 'opacity-50'
          )}
          style={{ filter: 'drop-shadow(0 0 6px var(--accent-1))' }}
        />
      </svg>
      <div className="relative flex flex-col items-center">{children}</div>
    </div>
  )
}
