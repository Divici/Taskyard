// The timer ring's geometry, shared by the ring (ProgressRing.tsx) and the label inside it
// (TimerTool.tsx), so the "Focus: <task>" line is sized from the circle rather than guessed.

/** Outer box of the ring, CSS px. */
export const RING_SIZE = 148
export const RING_STROKE = 6
/** Radius of the arc's centre line (6 px of room for the glow). */
export const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2 - 6
/** The inside edge of the stroke: text must stay within this circle. */
export const RING_INNER_RADIUS = RING_RADIUS - RING_STROKE / 2

/** Width of the inner circle at `offset` px above or below its centre (0 outside it). */
export function innerChordWidth(offset: number): number {
  const d = Math.abs(offset)
  if (d >= RING_INNER_RADIUS) return 0
  return 2 * Math.sqrt(RING_INNER_RADIUS ** 2 - d ** 2)
}

/**
 * The status line under the countdown ("Focus: Write report", "Paused"). Its bottom edge sits
 * about 32 px below the ring's centre (a 44 px clock line, 2 px gap, a 16 px label line, centred
 * together); `padding` keeps it clear of the stroke's inner edge on both sides.
 */
export const RING_LABEL = { maxWidth: 92, bottom: 32, padding: 6 } as const
