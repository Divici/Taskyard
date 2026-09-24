export interface ReseatThrottleOptions {
  /** Re-seats allowed inside `windowMs` before backing off. */
  limit: number
  windowMs: number
  baseBackoffMs: number
  maxBackoffMs: number
}

/**
 * Another desktop-level app that also wants to sit directly above the shell window would make
 * the sentinel re-seat twice a second forever (visible flicker, log spam). Past 6 re-seats in
 * 5 s the sentinel backs off: 2 s, 4 s, 8 s … up to 60 s, until 5 s pass without a re-seat.
 */
export const RESEAT_THROTTLE: ReseatThrottleOptions = {
  limit: 6,
  windowMs: 5_000,
  baseBackoffMs: 2_000,
  maxBackoffMs: 60_000
}

export interface ReseatThrottle {
  /** False while backing off. */
  allows(now: number): boolean
  /** Records a re-seat. Returns the length of a back-off that starts now, or 0. */
  record(now: number): number
  /** A check found nothing out of place. True when that ends a back-off episode. */
  settle(now: number): boolean
}

export function createReseatThrottle(
  options: ReseatThrottleOptions = RESEAT_THROTTLE
): ReseatThrottle {
  let stamps: number[] = []
  let inEpisode = false
  let backoff = options.baseBackoffMs
  let backoffUntil = 0

  return {
    allows: (now) => now >= backoffUntil,

    record(now) {
      stamps = [...stamps.filter((stamp) => now - stamp < options.windowMs), now]
      if (!inEpisode && stamps.length <= options.limit) return 0
      // Once fighting, every further re-seat doubles the pause until things settle.
      inEpisode = true
      const started = backoff
      backoffUntil = now + started
      backoff = Math.min(backoff * 2, options.maxBackoffMs)
      return started
    },

    settle(now) {
      const last = stamps.at(-1)
      if (!inEpisode || (last !== undefined && now - last < options.windowMs)) return false
      inEpisode = false
      stamps = []
      backoff = options.baseBackoffMs
      return true
    }
  }
}
