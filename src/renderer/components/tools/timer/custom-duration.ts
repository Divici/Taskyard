import { TIMER_MAX_HOURS, TIMER_MAX_MS, TIMER_MIN_MS } from '@shared/timer-state'

// The timer's custom fields (hours · minutes) ↔ one duration in milliseconds.

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** A duration as the custom fields show it: whole hours and the minutes left over. */
export function splitDuration(ms: number): { hours: string; minutes: string } {
  return {
    hours: String(Math.floor(ms / HOUR)),
    minutes: String(Math.floor((ms % HOUR) / MINUTE))
  }
}

/**
 * The custom fields' duration, or null when either field is out of range: whole numbers, hours
 * 0–99 and minutes 0–59, at least a minute between them. Minutes past 59 belong in the hours
 * field, so "90 min" is refused rather than carried.
 */
export function customDuration(hours: string, minutes: string): number | null {
  if (hours.trim() === '' || minutes.trim() === '') return null
  const h = Number(hours)
  const m = Number(minutes)
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null
  if (h < 0 || h > TIMER_MAX_HOURS || m < 0 || m > 59) return null
  const ms = h * HOUR + m * MINUTE
  return ms >= TIMER_MIN_MS && ms <= TIMER_MAX_MS ? ms : null
}
