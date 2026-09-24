import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installQuitFlush, installSessionEndFlush, type QuitFlushTarget } from './quit-flush'

interface QuitEvent {
  preventDefault: ReturnType<typeof vi.fn>
}

/** An `app` whose quit() emits before-quit again, as Electron does; records every event. */
function fakeApp(): EventEmitter & { quit: ReturnType<typeof vi.fn>; events: QuitEvent[] } {
  const events: QuitEvent[] = []
  const app = Object.assign(new EventEmitter(), { quit: vi.fn(), events })
  app.quit.mockImplementation(() => requestQuit(app))
  return app
}

function requestQuit(app: EventEmitter & { events: QuitEvent[] }): QuitEvent {
  const event = { preventDefault: vi.fn() }
  app.events.push(event)
  app.emit('before-quit', event)
  return event
}

function quietLog(): {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
} {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

/** Stores with something to write until their flush resolves. */
function stores(flushAll: () => Promise<void>): QuitFlushTarget & { dirty: boolean } {
  const target = {
    dirty: true,
    hasPendingWrites: () => target.dirty,
    flushAll: vi.fn(async () => {
      await flushAll()
      target.dirty = false
    })
  }
  return target
}

afterEach(() => {
  vi.useRealTimers()
})

describe('installQuitFlush', () => {
  it('lets a quit through untouched when nothing is waiting to be written', () => {
    const app = fakeApp()
    const target = stores(async () => {})
    target.dirty = false
    installQuitFlush(app, target, quietLog())

    const event = requestQuit(app)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(target.flushAll).not.toHaveBeenCalled()
  })

  it('holds a quit until every pending write is on disk, then quits once', async () => {
    const app = fakeApp()
    let release!: () => void
    const target = stores(() => new Promise<void>((resolve) => (release = resolve)))
    installQuitFlush(app, target, quietLog())

    const first = requestQuit(app)

    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(target.flushAll).toHaveBeenCalledOnce()
    expect(app.quit).not.toHaveBeenCalled()

    release()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())
    // The quit it re-issued went straight through.
    expect(app.events.at(-1)?.preventDefault).not.toHaveBeenCalled()
    expect(target.flushAll).toHaveBeenCalledOnce()
  })

  it('ignores repeated quit requests while the flush is running', async () => {
    const app = fakeApp()
    let release!: () => void
    const target = stores(() => new Promise<void>((resolve) => (release = resolve)))
    installQuitFlush(app, target, quietLog())

    requestQuit(app)
    const again = requestQuit(app)

    expect(again.preventDefault).toHaveBeenCalledOnce()
    expect(target.flushAll).toHaveBeenCalledOnce()
    release()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())
  })

  it('flushes again when a cancelled quit is repeated after new changes', async () => {
    const app = fakeApp()
    const target = stores(async () => {})
    installQuitFlush(app, target, quietLog())
    requestQuit(app)
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())
    // Something cancelled that quit (the app kept running) and the user changed a setting.
    target.dirty = true

    const repeated = requestQuit(app)

    expect(repeated.preventDefault).toHaveBeenCalledOnce()
    expect(target.flushAll).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(2))
  })

  it('logs a rejected flush and quits anyway, without looping', async () => {
    const app = fakeApp()
    const log = quietLog()
    const failure = new Error('disk full')
    const target = stores(() => Promise.reject(failure))
    installQuitFlush(app, target, log)

    requestQuit(app)

    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())
    expect(log.error).toHaveBeenCalledWith('quit: flushing stores failed', failure)
    // Writes are still pending, but the re-issued quit is not held a second time.
    expect(target.hasPendingWrites()).toBe(true)
    expect(app.events.at(-1)?.preventDefault).not.toHaveBeenCalled()
    expect(target.flushAll).toHaveBeenCalledOnce()
  })

  it('logs a flush that throws synchronously and still quits', async () => {
    const app = fakeApp()
    const log = quietLog()
    const failure = new Error('store not loaded')
    const target: QuitFlushTarget = {
      hasPendingWrites: () => true,
      flushAll: () => {
        throw failure
      }
    }
    installQuitFlush(app, target, log)

    expect(() => requestQuit(app)).not.toThrow()

    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())
    expect(log.error).toHaveBeenCalledWith('quit: flushing stores failed', failure)
  })

  it('gives up waiting on a hung flush after the timeout and quits', async () => {
    vi.useFakeTimers()
    const app = fakeApp()
    const log = quietLog()
    const target = stores(() => new Promise<void>(() => {}))
    installQuitFlush(app, target, log, { timeoutMs: 5_000 })

    requestQuit(app)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(app.quit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(log.error).toHaveBeenCalledWith(
      'quit: flushing stores failed',
      expect.objectContaining({ message: 'flush timed out after 5000 ms' })
    )
  })
})

describe('installSessionEndFlush', () => {
  it('flushes synchronously when Windows ends the session (no before-quit is emitted then)', () => {
    const app = new EventEmitter()
    const window = new EventEmitter()
    const flushSync = vi.fn()
    installSessionEndFlush(app, flushSync, quietLog())

    app.emit('browser-window-created', {}, window)
    window.emit('session-end', {})

    expect(flushSync).toHaveBeenCalledOnce()
  })

  it('flushes once even when several windows report the session end', () => {
    const app = new EventEmitter()
    const windows = [new EventEmitter(), new EventEmitter()]
    const flushSync = vi.fn()
    installSessionEndFlush(app, flushSync, quietLog())

    for (const window of windows) app.emit('browser-window-created', {}, window)
    for (const window of windows) window.emit('session-end', {})

    expect(flushSync).toHaveBeenCalledOnce()
  })

  it('logs a failing synchronous flush instead of throwing into Electron', () => {
    const app = new EventEmitter()
    const window = new EventEmitter()
    const log = quietLog()
    const failure = new Error('EPERM')
    installSessionEndFlush(
      app,
      () => {
        throw failure
      },
      log
    )
    app.emit('browser-window-created', {}, window)

    expect(() => window.emit('session-end', {})).not.toThrow()
    expect(log.error).toHaveBeenCalledWith('session-end: flushing stores failed', failure)
  })
})
