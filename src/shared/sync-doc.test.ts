import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeMain, tick, type FakeWindow } from './test/fake-main'
import { createSyncedDoc, type SyncedDoc } from './sync-doc'

interface Counter {
  n: number
  log: string[]
}

const increment = (counter: Counter): Counter => ({ ...counter, n: counter.n + 1 })
const note =
  (entry: string) =>
  (counter: Counter): Counter => ({ ...counter, log: [...counter.log, entry] })

interface Client {
  window: FakeWindow<Counter>
  doc: SyncedDoc<Counter>
  views: Counter[]
  onError: ReturnType<typeof vi.fn>
}

function client(main: FakeMain<Counter>, hydrate = true): Client {
  const window = main.connect()
  const views: Counter[] = []
  const onError = vi.fn()
  const doc = createSyncedDoc<Counter>({
    initial: { n: 0, log: ['defaults'] },
    transport: window.transport,
    onView: (view) => views.push(view),
    onError,
    backoff: { baseMs: 1, maxMs: 4 }
  })
  window.receive = (snapshot) => doc.receive(snapshot)
  window.busy = () => doc.pendingCount > 0
  if (hydrate) doc.receive(main.snapshot())
  return { window, doc, views, onError }
}

function fresh(): FakeMain<Counter> {
  return new FakeMain<Counter>({ n: 0, log: [] })
}

describe('createSyncedDoc', () => {
  it('receive() hydrates the view from main’s snapshot', () => {
    const main = fresh()
    const a = client(main, false)
    expect(a.doc.hydrated).toBe(false)

    a.doc.receive({ revision: 4, data: { n: 9, log: ['disk'] } })

    expect(a.doc.hydrated).toBe(true)
    expect(a.doc.revision).toBe(4)
    expect(a.doc.view).toEqual({ n: 9, log: ['disk'] })
    expect(a.views).toEqual([{ n: 9, log: ['disk'] }])
  })

  it('shows a mutation at once and saves it against the current revision', async () => {
    const main = fresh()
    const a = client(main)
    const save = vi.spyOn(a.window.transport, 'save')

    a.doc.mutate(increment)

    expect(a.doc.view.n).toBe(1)
    await tick()
    expect(save).toHaveBeenCalledExactlyOnceWith({ baseRevision: 1, data: { n: 1, log: [] } })
    await main.settle()
    expect(a.doc.revision).toBe(2)
    expect(a.doc.pendingCount).toBe(0)
  })

  it('batches mutations made while a save is in flight into one follow-up save', async () => {
    const main = fresh()
    const a = client(main)
    a.doc.mutate(note('one'))
    await tick()

    a.doc.mutate(note('two'))
    a.doc.mutate(note('three'))
    await main.settle()

    expect(main.saves).toBe(2)
    expect(main.data.log).toEqual(['one', 'two', 'three'])
    expect(a.doc.view).toEqual(main.data)
  })

  it('on a stale reply, rebases its mutations onto main’s data and saves again', async () => {
    const main = fresh()
    const a = client(main)
    const b = client(main)

    a.doc.mutate(note('from A'))
    b.doc.mutate(note('from B')) // built on revision 1 too
    await tick()
    expect(b.window.inbox.map((delivery) => delivery.label)).toEqual(['event r2', 'reply'])
    // B hears "stale" before it sees A's broadcast.
    expect(await b.window.deliver('last')).toBe('reply')

    expect(b.doc.view.log).toEqual(['from A', 'from B'])
    await main.settle()

    expect(main.data.log).toEqual(['from A', 'from B'])
    expect(a.doc.view).toEqual(main.data)
    expect(b.doc.view).toEqual(main.data)
    expect(main.revision).toBe(3)
  })

  it.each(['fifo', 'lifo'] as const)(
    'two windows counting at once never lose or double an increment (%s)',
    async (order) => {
      const main = fresh()
      const a = client(main)
      const b = client(main)

      for (let round = 0; round < 3; round++) {
        a.doc.mutate(increment)
        b.doc.mutate(increment)
        await tick()
      }
      await main.settle(order)

      expect(main.data.n).toBe(6)
      expect(a.doc.view).toEqual(main.data)
      expect(b.doc.view).toEqual(main.data)
    }
  )

  it('does not apply its own save twice when the echo arrives before the reply', async () => {
    const main = fresh()
    const a = client(main)

    a.doc.mutate(increment)
    await tick()
    expect(await a.window.deliver('first')).toBe('event r2')
    expect(await a.window.deliver('first')).toBe('reply')

    expect(a.doc.view.n).toBe(1)
    expect(main.saves).toBe(1)
  })

  it('adopts a newer change from another window when it has nothing pending', async () => {
    const main = fresh()
    const a = client(main)
    const b = client(main)

    b.doc.mutate(note('from B'))
    await main.settle()

    expect(a.doc.view.log).toEqual(['from B'])
    expect(a.doc.revision).toBe(2)
  })

  it('rebases pending mutations onto a newer change that arrived while its save was in flight', async () => {
    const main = fresh()
    const a = client(main)
    const b = client(main)
    b.doc.mutate(note('B1'))
    await tick() // B's save is accepted: revision 2
    a.doc.mutate(note('A1')) // stale, but its reply is not delivered yet
    await tick()
    a.doc.mutate(note('A2')) // queued behind the in-flight save

    await main.settle('lifo')

    expect(main.data.log).toEqual(['B1', 'A1', 'A2'])
    expect(a.doc.view).toEqual(main.data)
    expect(b.doc.view).toEqual(main.data)
  })

  it('ignores a snapshot that is not newer than what it has', async () => {
    const main = fresh()
    const a = client(main)
    a.doc.mutate(increment)
    await main.settle()

    a.doc.receive({ revision: 2, data: { n: 99, log: [] } })
    a.doc.receive({ revision: 1, data: { n: 42, log: [] } })

    expect(a.doc.view.n).toBe(1)
  })

  it('applies a change made before hydration to the loaded data, never to the defaults', async () => {
    const main = new FakeMain<Counter>({ n: 5, log: ['disk'] })
    const a = client(main, false)
    const save = vi.spyOn(a.window.transport, 'save')

    a.doc.mutate(note('early'))
    await tick()
    expect(save).not.toHaveBeenCalled()
    expect(a.doc.view.log).toEqual(['defaults', 'early'])

    a.doc.receive(main.snapshot())
    await main.settle()

    expect(save).toHaveBeenCalledExactlyOnceWith({
      baseRevision: 1,
      data: { n: 5, log: ['disk', 'early'] }
    })
    expect(main.data).toEqual({ n: 5, log: ['disk', 'early'] })
  })

  it('keeps a change on screen but stops saving when main reports the file read-only', async () => {
    const main = fresh()
    main.readOnly = true
    const a = client(main)

    a.doc.mutate(increment)
    await main.settle()
    a.doc.mutate(increment)
    await main.settle()

    expect(a.doc.view.n).toBe(2)
    expect(main.saves).toBe(1)
    expect(a.onError).not.toHaveBeenCalled()
  })

  it('reverts a save main rejected outright and reports it, then keeps working', async () => {
    const main = fresh()
    const failure = new Error('invalid arguments for storage:save')
    const transport = {
      save: vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ ok: true, revision: 2 })
    }
    const onError = vi.fn()
    const doc = createSyncedDoc<Counter>({
      initial: { n: 0, log: [] },
      transport,
      onView: () => {},
      onError
    })
    doc.receive(main.snapshot())

    doc.mutate(increment)
    await tick()
    await tick()

    expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(doc.view.n).toBe(0)
    doc.mutate(note('later'))
    await tick()
    expect(transport.save).toHaveBeenLastCalledWith({
      baseRevision: 1,
      data: { n: 0, log: ['later'] }
    })
  })

  it('treats a transport that throws synchronously like a rejected save', async () => {
    const onError = vi.fn()
    const doc = createSyncedDoc<Counter>({
      initial: { n: 0, log: [] },
      transport: {
        save: () => {
          throw new Error('window.taskyard is missing')
        }
      },
      onView: () => {},
      onError
    })
    doc.receive({ revision: 1, data: { n: 0, log: [] } })

    doc.mutate(increment)
    await tick()

    expect(onError).toHaveBeenCalledOnce()
    expect(doc.view.n).toBe(0)
  })
})

/** A transport that answers `stale` a set number of times (as if another window kept saving). */
function contendedTransport(staleReplies: number): {
  transport: { save: ReturnType<typeof vi.fn> }
  sentAt: number[]
} {
  let revision = 1
  let left = staleReplies
  const sentAt: number[] = []
  const transport = {
    save: vi.fn(async ({ data }: { baseRevision: number; data: Counter }) => {
      sentAt.push(Date.now())
      if (left > 0) {
        left -= 1
        revision += 1
        return { ok: false, reason: 'stale', revision, data: { n: data.n - 1 + 10, log: [] } }
      }
      revision += 1
      return { ok: true, revision }
    })
  }
  return { transport, sentAt }
}

describe('createSyncedDoc — backoff on repeated stale replies', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['full jitter draw', 1, [0, 50, 100, 200, 200]],
    ['lowest jitter draw', 0, [0, 25, 50, 100, 100]]
  ])(
    'retries the first stale reply at once, then waits with growing, capped delays (%s)',
    async (_label, draw, expectedGaps) => {
      vi.useFakeTimers()
      const { transport, sentAt } = contendedTransport(5)
      const onError = vi.fn()
      const doc = createSyncedDoc<Counter>({
        initial: { n: 0, log: [] },
        transport,
        onView: () => {},
        onError,
        backoff: { baseMs: 50, maxMs: 200, random: () => draw }
      })
      doc.receive({ revision: 1, data: { n: 0, log: [] } })

      doc.mutate(increment)
      await vi.advanceTimersByTimeAsync(2_000)

      expect(transport.save).toHaveBeenCalledTimes(6)
      const gaps = sentAt.slice(1).map((time, index) => time - sentAt[index])
      expect(gaps).toEqual(expectedGaps)
      // The change was never dropped: the accepted save carries it on top of the last data.
      expect(transport.save.mock.calls.at(-1)?.[0].data.n).toBe(doc.view.n)
      expect(doc.pendingCount).toBe(0)
      expect(onError).not.toHaveBeenCalled()
    }
  )

  it('while waiting, adopts newer data at once but keeps the retry on its schedule', async () => {
    vi.useFakeTimers()
    const { transport } = contendedTransport(2)
    const doc = createSyncedDoc<Counter>({
      initial: { n: 0, log: [] },
      transport,
      onView: () => {},
      onError: () => {},
      backoff: { baseMs: 100, maxMs: 100, random: () => 1 }
    })
    doc.receive({ revision: 1, data: { n: 0, log: [] } })
    doc.mutate(note('mine'))
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.save).toHaveBeenCalledTimes(2) // second stale reply: now waiting 100 ms

    doc.receive({ revision: 50, data: { n: 7, log: ['theirs'] } })
    await vi.advanceTimersByTimeAsync(99)

    expect(doc.view.log).toEqual(['theirs', 'mine'])
    expect(transport.save).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.save).toHaveBeenCalledTimes(3)
    expect(transport.save.mock.calls[2][0]).toEqual({
      baseRevision: 50,
      data: { n: 7, log: ['theirs', 'mine'] }
    })
  })
})

/** "Set n to zero": changes nothing on data where n is already 0, but not on other data. */
const zero = (counter: Counter): Counter => (counter.n === 0 ? counter : { ...counter, n: 0 })

describe('createSyncedDoc — no-op mutations', () => {
  it('a mutation that returns the same data is neither kept nor sent once settled on main’s data', async () => {
    const main = fresh()
    const a = client(main)
    const save = vi.spyOn(a.window.transport, 'save')
    const identity = vi.fn((counter: Counter) => counter)

    a.doc.mutate(identity)
    await tick()

    expect(identity).toHaveBeenCalledOnce()
    expect(a.doc.pendingCount).toBe(0)
    expect(save).not.toHaveBeenCalled()
  })

  it('keeps a change made before hydration even when it matches the defaults, and replays it', async () => {
    const main = new FakeMain<Counter>({ n: 5, log: ['disk'] })
    const a = client(main, false)
    const save = vi.spyOn(a.window.transport, 'save')

    a.doc.mutate(zero) // n is 0 in the defaults, so this looks like a no-op now
    expect(a.doc.pendingCount).toBe(1)

    a.doc.receive(main.snapshot())
    await main.settle()

    expect(save).toHaveBeenCalledExactlyOnceWith({ baseRevision: 1, data: { n: 0, log: ['disk'] } })
    expect(main.data).toEqual({ n: 0, log: ['disk'] })
    expect(a.doc.view).toEqual(main.data)
  })

  it('keeps a no-op-looking change made while a save is in flight, and replays it after a stale reply', async () => {
    const main = fresh()
    const a = client(main)
    const b = client(main)
    b.doc.mutate(increment) // main moves to n = 1
    await tick()
    a.doc.mutate(note('x')) // in flight, will be stale
    await tick()

    a.doc.mutate(zero) // a no-op on A's view (n = 0), but not on main's data (n = 1)
    await main.settle()

    expect(main.data).toEqual({ n: 0, log: ['x'] })
    expect(a.doc.view).toEqual(main.data)
    expect(b.doc.view).toEqual(main.data)
  })

  it('drops queued changes, without sending, once they change nothing on the loaded data', async () => {
    const main = new FakeMain<Counter>({ n: 0, log: ['disk'] })
    const a = client(main, false)
    const save = vi.spyOn(a.window.transport, 'save')

    a.doc.mutate(zero)
    a.doc.receive(main.snapshot())
    await main.settle()

    expect(save).not.toHaveBeenCalled()
    expect(a.doc.pendingCount).toBe(0)
  })
})

describe('createSyncedDoc — mutations that throw', () => {
  it('a mutation that throws is not kept: the caller gets the error and the doc keeps working', async () => {
    const main = fresh()
    const a = client(main)
    const failure = new Error('bad mutation')

    expect(() =>
      a.doc.mutate(() => {
        throw failure
      })
    ).toThrow(failure)
    expect(a.doc.pendingCount).toBe(0)

    a.doc.mutate(increment)
    await main.settle()
    expect(main.data.n).toBe(1)
    expect(a.doc.view.n).toBe(1)
  })

  it('a mutation that throws only when replayed on newer data is dropped and reported', async () => {
    const main = fresh()
    const a = client(main)
    const b = client(main)
    const failure = new Error('item vanished')
    const fragile = (counter: Counter): Counter => {
      if (counter.log.includes('from B')) throw failure
      return note('fragile')(counter)
    }

    b.doc.mutate(note('from B'))
    await tick() // B's save is accepted before A changes anything
    a.doc.mutate(fragile)
    a.doc.mutate(increment)
    await main.settle()

    expect(a.onError).toHaveBeenCalledExactlyOnceWith(failure)
    expect(main.data).toEqual({ n: 1, log: ['from B'] })
    expect(a.doc.view).toEqual(main.data)
    expect(a.doc.pendingCount).toBe(0)
  })
})

describe('createSyncedDoc — dispose', () => {
  it('stops sending, ignores late replies and events', async () => {
    const main = fresh()
    const a = client(main)
    const save = vi.spyOn(a.window.transport, 'save')
    a.doc.mutate(increment)
    await tick() // in flight
    a.doc.mutate(increment) // queued behind it

    a.doc.dispose()
    await main.settle()
    a.doc.mutate(increment)
    a.doc.receive({ revision: 99, data: { n: 42, log: [] } })
    await tick()

    expect(save).toHaveBeenCalledOnce()
    expect(a.views).toEqual([
      { n: 0, log: [] },
      { n: 1, log: [] },
      { n: 2, log: [] }
    ])
    expect(a.onError).not.toHaveBeenCalled()
  })

  it('cancels an armed backoff retry: nothing is sent after dispose', async () => {
    vi.useFakeTimers()
    try {
      const { transport } = contendedTransport(5)
      const doc = createSyncedDoc<Counter>({
        initial: { n: 0, log: [] },
        transport,
        onView: () => {},
        onError: () => {},
        backoff: { baseMs: 100, maxMs: 100, random: () => 1 }
      })
      doc.receive({ revision: 1, data: { n: 0, log: [] } })
      doc.mutate(increment)
      await vi.advanceTimersByTimeAsync(0)
      // Two stale replies: the retry is now waiting on a 100 ms timer.
      expect(transport.save).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(1)

      doc.dispose()
      expect(vi.getTimerCount()).toBe(0) // cancelled at once, not merely left to fire into nothing
      await vi.advanceTimersByTimeAsync(1_000)

      expect(transport.save).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createSyncedDoc — stale streak', () => {
  it('starts counting again when a rebuild drops every pending change', async () => {
    vi.useFakeTimers()
    try {
      // Replies: stale (data fine) → stale (data that makes the change throw) → stale → ok.
      const replies = [
        { ok: false, reason: 'stale', revision: 2, data: { n: 0, log: [] } },
        { ok: false, reason: 'stale', revision: 3, data: { n: 0, log: ['boom'] } },
        { ok: false, reason: 'stale', revision: 4, data: { n: 0, log: ['boom'] } },
        { ok: true, revision: 5 }
      ]
      const sentAt: number[] = []
      const transport = {
        save: vi.fn(async () => {
          sentAt.push(Date.now())
          return replies.shift()!
        })
      }
      const onError = vi.fn()
      const doc = createSyncedDoc<Counter>({
        initial: { n: 0, log: [] },
        transport: transport as unknown as Parameters<
          typeof createSyncedDoc<Counter>
        >[0]['transport'],
        onView: () => {},
        onError,
        backoff: { baseMs: 100, maxMs: 100, random: () => 1 }
      })
      doc.receive({ revision: 1, data: { n: 0, log: [] } })
      const fragile = (counter: Counter): Counter => {
        if (counter.log.includes('boom')) throw new Error('gone')
        return increment(counter)
      }

      doc.mutate(fragile)
      await vi.advanceTimersByTimeAsync(0)
      expect(onError).toHaveBeenCalledOnce() // dropped on the 2nd stale reply
      expect(doc.pendingCount).toBe(0)
      expect(vi.getTimerCount()).toBe(0)

      doc.mutate(note('next'))
      await vi.advanceTimersByTimeAsync(0)

      // This change's first stale reply is retried at once (the streak restarted), not after 100 ms.
      expect(transport.save).toHaveBeenCalledTimes(4)
      expect(sentAt[3] - sentAt[2]).toBe(0)
      expect(doc.view.log).toEqual(['boom', 'next'])
    } finally {
      vi.useRealTimers()
    }
  })
})
