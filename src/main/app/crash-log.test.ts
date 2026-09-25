import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installCrashLogging } from './crash-log'

describe('installCrashLogging', () => {
  it('logs an uncaught exception and keeps the process running', () => {
    const proc = new EventEmitter()
    const exit = vi.fn()
    const log = { error: vi.fn() }
    installCrashLogging(Object.assign(proc, { exit }), log)

    const error = new Error('boom')
    proc.emit('uncaughtException', error)

    expect(log.error).toHaveBeenCalledExactlyOnceWith(
      'main: unhandled error (still running)',
      error
    )
    expect(exit).not.toHaveBeenCalled()
  })

  it('logs an unhandled rejection, whatever was rejected', () => {
    const proc = new EventEmitter()
    const log = { error: vi.fn() }
    installCrashLogging(Object.assign(proc, { exit: vi.fn() }), log)

    proc.emit('unhandledRejection', 'no reason object')

    expect(log.error).toHaveBeenCalledExactlyOnceWith(
      'main: unhandled promise rejection (still running)',
      'no reason object'
    )
  })

  it('a logger that throws never turns one error into a crash loop', () => {
    const proc = new EventEmitter()
    const log = {
      error: vi.fn(() => {
        throw new Error('disk full')
      })
    }
    installCrashLogging(Object.assign(proc, { exit: vi.fn() }), log)

    expect(() => proc.emit('uncaughtException', new Error('boom'))).not.toThrow()
  })

  it('returns the uninstaller', () => {
    const proc = new EventEmitter()
    const uninstall = installCrashLogging(Object.assign(proc, { exit: vi.fn() }), {
      error: vi.fn()
    })
    expect(proc.listenerCount('uncaughtException')).toBe(1)
    uninstall()
    expect(proc.listenerCount('uncaughtException')).toBe(0)
    expect(proc.listenerCount('unhandledRejection')).toBe(0)
  })
})
