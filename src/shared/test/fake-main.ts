// Test support: an in-memory stand-in for main's side of the storage protocol (revision check,
// stale reply, broadcast to every window including the sender) with manual delivery, so tests can
// replay any interleaving of replies and events.
import type { SaveRequest, SaveResultOf, Snapshot } from '../ipc'

interface Delivery {
  label: string
  deliver(): void
}

export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export class FakeMain<T> {
  revision = 1
  readOnly = false
  saves = 0
  readonly windows: Array<FakeWindow<T>> = []

  constructor(public data: T) {}

  snapshot(): Snapshot<T> {
    return { revision: this.revision, data: structuredClone(this.data) }
  }

  connect(): FakeWindow<T> {
    const window = new FakeWindow(this)
    this.windows.push(window)
    return window
  }

  handleSave(request: SaveRequest<T>): SaveResultOf<T> {
    this.saves += 1
    if (this.readOnly) return { ok: false, reason: 'read-only' }
    if (request.baseRevision !== this.revision) {
      return { ok: false, reason: 'stale', ...this.snapshot() }
    }
    this.data = structuredClone(request.data)
    this.revision += 1
    for (const window of this.windows) window.enqueueEvent(this.snapshot())
    return { ok: true, revision: this.revision }
  }

  /**
   * Delivers queued replies and events, alternating windows, until nothing is left and no
   * window reports unsaved work (a backoff retry may still be waiting on a timer).
   */
  async settle(order: 'fifo' | 'lifo' = 'fifo'): Promise<void> {
    for (let step = 0; step < 2_000; step++) {
      await tick()
      const loaded = this.windows.filter((window) => window.inbox.length > 0)
      if (loaded.length === 0) {
        if (this.windows.some((window) => window.busy())) continue
        return
      }
      const window = loaded[step % loaded.length]
      const delivery = order === 'fifo' ? window.inbox.shift() : window.inbox.pop()
      delivery?.deliver()
    }
    throw new Error('the windows never settled')
  }
}

export class FakeWindow<T> {
  readonly inbox: Delivery[] = []
  /** Where this window's events go; set to the synced doc's `receive`. */
  receive: (snapshot: Snapshot<T>) => void = () => {}
  /** Whether the window still has unsaved work; `settle` waits for it. */
  busy: () => boolean = () => false

  readonly transport = {
    save: (request: SaveRequest<T>): Promise<SaveResultOf<T>> => {
      // Main handles the request the moment it arrives; only the reply's delivery is deferred.
      const result = this.main.handleSave(structuredClone(request))
      return new Promise((resolve) =>
        this.inbox.push({ label: 'reply', deliver: () => resolve(structuredClone(result)) })
      )
    }
  }

  constructor(private readonly main: FakeMain<T>) {}

  enqueueEvent(snapshot: Snapshot<T>): void {
    this.inbox.push({ label: `event r${snapshot.revision}`, deliver: () => this.receive(snapshot) })
  }

  /** Delivers this window's next queued message, then lets the resulting promises run. */
  async deliver(pick: 'first' | 'last' = 'first'): Promise<string | undefined> {
    const delivery = pick === 'first' ? this.inbox.shift() : this.inbox.pop()
    delivery?.deliver()
    await tick()
    return delivery?.label
  }
}
