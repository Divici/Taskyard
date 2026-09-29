// The ring's geometry, shared by the ring (ProgressRing.tsx) and the state caption inside it, so
// the caption is sized from the circle rather than guessed. Used by the Timer and the Stopwatch.

/** Outer box of the ring, CSS px. */
export const RING_SIZE = 128
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
 * Round 2: the state caption under the clock ("Ready", "Paused", "Time’s up"). The clock stays
 * centred in the ring (34 px type on a ~41 px line: about 21 px either side of the centre); the caption's 16 px
 * line starts `top` px below the centre and ends `bottom` px below it, and `padding` keeps it
 * clear of the stroke's inner edge on both sides. The "Focus: <task>" line lives under the ring.
 */
export const RING_LABEL = { maxWidth: 60, top: 21, bottom: 37, padding: 6 } as const
