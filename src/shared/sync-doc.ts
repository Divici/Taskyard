import type { SaveRequest, SaveResultOf, Snapshot } from './ipc'

/** A local change, as a pure function of the data, so it can be replayed on newer data. */
export type Mutation<T> = (data: T) => T

export interface SyncTransport<T> {
  save(request: SaveRequest<T>): Promise<SaveResultOf<T>>
}

/** Delay before re-sending after the 2nd, 3rd … stale reply in a row (the 1st retries at once). */
export interface BackoffOptions {
  /** Delay after the 2nd stale reply; doubles after each further one. */
  baseMs?: number
  /** Upper bound for the delay. */
  maxMs?: number
  /** Jitter source in [0, 1): the delay is drawn from [d/2, d). */
  random?: () => number
}

export const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  baseMs: 50,
  maxMs: 1_000,
  random: Math.random
}

export interface SyncedDocOptions<T> {
  /** What the view shows before main's data arrives. Never saved as such. */
  initial: T
  transport: SyncTransport<T>
  /** Called with the new view whenever it changes. */
  onView(view: T): void
  /**
   * A save main rejected outright (invalid data, untrusted frame) — its changes were undone — or
   * a pending change that threw when replayed on newer data and was dropped.
   */
  onError(error: unknown): void
  backoff?: BackoffOptions
}

export interface SyncedDoc<T> {
  /** What the user sees: main's data with the unsaved mutations applied on top. */
  readonly view: T
  /** The revision of main's data the view is built on; 0 until the first snapshot arrives. */
  readonly revision: number
  readonly hydrated: boolean
  /** Mutations not yet confirmed by main. */
  readonly pendingCount: number
  /** Main's data at a revision: the loaded file, a `storage:changed` event or a stale reply. */
  receive(snapshot: Snapshot<T>): void
  /**
   * Applies the change now and saves it. A mutation that throws is not kept (the error reaches
   * the caller). One that returns the same data is dropped when the view is main's latest data
   * with nothing pending; otherwise it is kept and replayed like any other change.
   */
  mutate(mutation: Mutation<T>): void
  /** Stops for good: nothing more is sent, and late replies, events and retries are ignored. */
  dispose(): void
}

/**
 * One renderer's copy of a store kept in step with main by optimistic concurrency. Main's data
 * (`confirmed`, at `revision`) plus the local `pending` mutations make up the view. Mutations
 * are sent as one full-file save against `revision`, one save at a time:
 * - accepted → the sent mutations are confirmed;
 * - stale (another window saved first) → main's newer data is adopted and every pending
 *   mutation is replayed on top of it, then saved again — at once the first time, then after a
 *   jittered, capped, doubling delay so a window cannot starve another; nothing is ever dropped;
 * - read-only → the change stays on screen, nothing more is sent (the banner explains);
 * - rejected → the sent mutations are dropped and the view goes back to main's data.
 * Snapshots that arrive while a save is in flight wait for its reply, so a window's own echo can
 * never be applied twice; snapshots not newer than `revision` are ignored.
 */
export function createSyncedDoc<T>(options: SyncedDocOptions<T>): SyncedDoc<T> {
  const backoff = { ...DEFAULT_BACKOFF, ...options.backoff }
  let confirmed = options.initial
  let revision = 0
  let pending: Array<Mutation<T>> = []
  let view = options.initial
  let inFlight: { count: number; data: T } | null = null
  let sendQueued = false
  let buffered: Snapshot<T> | null = null
  let readOnly = false
  let disposed = false
  let staleStreak = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  function show(next: T): void {
    if (next === view) return
    view = next
    options.onView(view)
  }

  /** Replays pending mutations on `confirmed`; one that now throws is dropped and reported. */
  function rebuild(): void {
    let data = confirmed
    const kept: Array<Mutation<T>> = []
    for (const mutation of pending) {
      try {
        data = mutation(data)
        kept.push(mutation)
      } catch (error) {
        options.onError(error)
      }
    }
    // Every change this window was retrying is gone: the contention is over for it.
    if (kept.length === 0 && pending.length > 0) staleStreak = 0
    pending = kept
    show(data)
  }

  function adopt(snapshot: Snapshot<T>): void {
    if (snapshot.revision <= revision) return
    confirmed = snapshot.data
    revision = snapshot.revision
    rebuild()
  }

  function scheduleSend(): void {
    if (sendQueued || disposed) return
    sendQueued = true
    // Mutations made in the same task go out as one save.
    queueMicrotask(() => {
      sendQueued = false
      send()
    })
  }

  function retryDelay(): number {
    if (staleStreak <= 1) return 0
    const ceiling = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (staleStreak - 2))
    return ceiling / 2 + backoff.random() * (ceiling / 2)
  }

  function send(): void {
    if (disposed || inFlight || retryTimer !== undefined) return
    if (revision === 0 || readOnly || pending.length === 0) return
    if (view === confirmed) {
      // Replayed on main's latest data, every pending change turned out to change nothing.
      pending = []
      staleStreak = 0
      return
    }
    const request = { baseRevision: revision, data: view }
    inFlight = { count: pending.length, data: view }
    let reply: Promise<SaveResultOf<T>>
    try {
      reply = options.transport.save(request)
    } catch (error) {
      reply = Promise.reject(error)
    }
    reply.then(onReply, onFailure)
  }

  function settle(): void {
    if (buffered) {
      const snapshot = buffered
      buffered = null
      adopt(snapshot)
    }
    const delay = retryDelay()
    if (delay > 0 && pending.length > 0) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        send()
      }, delay)
      return
    }
    scheduleSend()
  }

  function onReply(result: SaveResultOf<T>): void {
    if (disposed) return
    const sent = inFlight!
    inFlight = null
    if (result.ok) {
      staleStreak = 0
      pending = pending.slice(sent.count)
      confirmed = sent.data
      revision = Math.max(revision, result.revision)
    } else if (result.reason === 'stale') {
      staleStreak += 1
      // None of the sent mutations were applied: replay all of them on main's current data.
      confirmed = result.data
      revision = result.revision
      rebuild()
    } else {
      readOnly = true
      pending = []
    }
    settle()
  }

  function onFailure(error: unknown): void {
    if (disposed) return
    const sent = inFlight!
    inFlight = null
    staleStreak = 0
    pending = pending.slice(sent.count)
    rebuild()
    options.onError(error)
    settle()
  }

  return {
    get view() {
      return view
    },
    get revision() {
      return revision
    },
    get hydrated() {
      return revision > 0
    },
    get pendingCount() {
      return pending.length
    },

    receive(snapshot) {
      if (disposed) return
      if (inFlight) {
        if (!buffered || snapshot.revision > buffered.revision) buffered = snapshot
        return
      }
      adopt(snapshot)
      scheduleSend()
    },

    mutate(mutation) {
      if (disposed) return
      // Run it first: a mutation that throws never becomes pending (the caller gets the error).
      const next = mutation(view)
      // A change that does nothing is dropped only when the view is main's latest known data
      // with nothing outstanding. Before hydration the view is the defaults, and with changes
      // pending or in flight it may be replayed on different data: there, "no change now" can
      // still be a change, so it is kept (send() drops it if the replay changes nothing).
      if (next === view && revision > 0 && pending.length === 0) return
      if (readOnly) {
        // Nothing can be saved this session; keep the change on screen only.
        show(next)
        return
      }
      pending = [...pending, mutation]
      show(next)
      scheduleSend()
    },

    dispose() {
      disposed = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      pending = []
      buffered = null
    }
  }
}
