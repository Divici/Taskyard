import { describe, expect, it } from 'vitest'
import { restoreTaskbarState, type TaskbarStateIo } from './taskbar-restore'

interface FakeTaskbar {
  io: TaskbarStateIo
  state: { live: number | null; persisted: boolean | null }
  calls: string[]
  liveOverrides: (number | null)[]
}

/** A taskbar whose live (ABM) state and persisted (StuckRects3) auto-hide bit can drift. */
function fakeTaskbar(start: { live: number | null; persisted: boolean | null }): FakeTaskbar {
  const state = { ...start }
  const calls: string[] = []
  /** Reads that return something else once (a restarting Explorer re-applying the registry). */
  const liveOverrides: (number | null)[] = []
  const io: TaskbarStateIo = {
    live: () => (liveOverrides.length > 0 ? liveOverrides.shift()! : state.live),
    setLive: (value) => {
      calls.push(`setLive ${value}`)
      state.live = value
    },
    persistedAutoHide: () => state.persisted,
    setPersistedAutoHide: (on) => {
      calls.push(`setPersisted ${on}`)
      state.persisted = on
    },
    sleep: () => {}
  }
  return { io, state, calls, liveOverrides }
}

describe('restoreTaskbarState', () => {
  it('touches nothing when the live state and the registry already match the original', () => {
    const taskbar = fakeTaskbar({ live: 0, persisted: false })

    const result = restoreTaskbarState(taskbar.io, 0)

    expect(result).toMatchObject({ ok: true, attempts: 1, live: 0, persistedAutoHide: false })
    expect(taskbar.calls).toEqual([])
  })

  it('restores the live state and the persisted bit, so an Explorer restart keeps it', () => {
    // Explorer had saved auto-hide on to StuckRects3 during the run (measured).
    const taskbar = fakeTaskbar({ live: 1, persisted: true })

    const result = restoreTaskbarState(taskbar.io, 0)

    expect(result).toMatchObject({ ok: true, live: 0, persistedAutoHide: false })
    expect(taskbar.calls).toEqual(['setLive 0', 'setPersisted false'])
  })

  it('retries when a read after the set shows the old state again', () => {
    const taskbar = fakeTaskbar({ live: 1, persisted: false })
    // First check after the set: set took. Stability read: a restarted Explorer re-applied 1.
    taskbar.liveOverrides.push(0, 1)

    const result = restoreTaskbarState(taskbar.io, 0, { stableReads: 2 })

    expect(result).toMatchObject({ ok: true, attempts: 2, live: 0 })
    expect(taskbar.calls).toEqual(['setLive 0'])
  })

  it('gives up after the attempts and reports what it saw last', () => {
    const taskbar = fakeTaskbar({ live: 1, persisted: false })
    taskbar.io.setLive = (value) => taskbar.calls.push(`setLive ${value}`) // never takes

    const result = restoreTaskbarState(taskbar.io, 0, { attempts: 3 })

    expect(result).toEqual({ ok: false, attempts: 3, live: 1, persistedAutoHide: false })
    expect(taskbar.calls).toEqual(['setLive 0', 'setLive 0', 'setLive 0'])
  })

  it('keeps trying while there is no taskbar (Explorer still starting)', () => {
    const taskbar = fakeTaskbar({ live: 0, persisted: false })
    taskbar.liveOverrides.push(null, null)

    const result = restoreTaskbarState(taskbar.io, 0, { stableReads: 1 })

    expect(result).toMatchObject({ ok: true, attempts: 2, live: 0 })
    expect(taskbar.calls).toEqual([])
  })

  it('does not report success while the registry cannot be read', () => {
    const taskbar = fakeTaskbar({ live: 0, persisted: null })
    taskbar.io.setPersistedAutoHide = () => {} // the write fails too

    expect(restoreTaskbarState(taskbar.io, 0, { attempts: 2 })).toMatchObject({
      ok: false,
      persistedAutoHide: null
    })
  })
})
