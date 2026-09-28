import { ABS_AUTOHIDE } from './taskbar-state'

/** The taskbar's auto-hide as verify:zorder sees it: live (SHAppBarMessage) and persisted. */
export interface TaskbarStateIo {
  /** `ABM_GETSTATE`, or null while there is no taskbar (Explorer restarting). */
  live(): number | null
  setLive(state: number): void
  /** The auto-hide bit Explorer loads at start (StuckRects3), or null when unreadable. */
  persistedAutoHide(): boolean | null
  setPersistedAutoHide(on: boolean): void
  /** Synchronous: the restore also runs from a Ctrl+C handler. */
  sleep(ms: number): void
}

export interface RestoreOptions {
  attempts?: number
  /** Wait after a set, and between the stability reads. */
  settleMs?: number
  /** Consecutive matching reads needed before the state counts as restored. */
  stableReads?: number
}

export interface RestoreResult {
  ok: boolean
  attempts: number
  /** What was read last. */
  live: number | null
  persistedAutoHide: boolean | null
}

/**
 * Puts the taskbar back to `original` and checks that it stays there: sets the live state and
 * the persisted bit where they differ, then requires `stableReads` matching reads in a row
 * (a restarting Explorer re-applies the registry a moment later), retrying up to `attempts`.
 */
export function restoreTaskbarState(
  io: TaskbarStateIo,
  original: number,
  { attempts = 10, settleMs = 500, stableReads = 3 }: RestoreOptions = {}
): RestoreResult {
  const wantAutoHide = (original & ABS_AUTOHIDE) !== 0
  let live: number | null = null
  let persisted: boolean | null = null
  const read = (): boolean => {
    live = io.live()
    persisted = io.persistedAutoHide()
    return live === original && persisted === wantAutoHide
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!read()) {
      if (live !== null && live !== original) io.setLive(original)
      if (persisted !== wantAutoHide) io.setPersistedAutoHide(wantAutoHide)
      io.sleep(settleMs)
    }
    let stable = 0
    while (stable < stableReads && read()) {
      stable++
      if (stable < stableReads) io.sleep(settleMs)
    }
    if (stable === stableReads) {
      return { ok: true, attempts: attempt, live, persistedAutoHide: persisted }
    }
    io.sleep(settleMs)
  }
  return { ok: false, attempts, live, persistedAutoHide: persisted }
}
