import { describe, expect, it, vi, type Mock } from 'vitest'
import { acquireSingleInstanceLock, type SingleInstanceApp } from './single-instance'

type SecondInstanceListener = (event: unknown, argv: string[], workingDirectory: string) => void

interface FakeApp extends SingleInstanceApp {
  requestSingleInstanceLock: Mock<() => boolean>
  quit: Mock<() => void>
  on: Mock<(event: 'second-instance', listener: SecondInstanceListener) => void>
}

function fakeApp(gotLock: boolean): { app: FakeApp; listeners: SecondInstanceListener[] } {
  const listeners: SecondInstanceListener[] = []
  const app: FakeApp = {
    requestSingleInstanceLock: vi.fn(() => gotLock),
    quit: vi.fn(),
    on: vi.fn((_event, listener) => {
      listeners.push(listener)
    })
  }
  return { app, listeners }
}

describe('acquireSingleInstanceLock', () => {
  it('returns true and routes second-instance events to the callback when it owns the lock', () => {
    const { app, listeners } = fakeApp(true)
    const onSecondInstance = vi.fn()

    expect(acquireSingleInstanceLock(app, onSecondInstance)).toBe(true)
    expect(app.quit).not.toHaveBeenCalled()
    expect(app.on).toHaveBeenCalledWith('second-instance', expect.any(Function))

    listeners[0]({}, ['Taskyard.exe', '--flag'], 'C:\\work')
    expect(onSecondInstance).toHaveBeenCalledExactlyOnceWith(['Taskyard.exe', '--flag'], 'C:\\work')
  })

  it('quits and returns false when another instance already holds the lock', () => {
    const { app } = fakeApp(false)
    const onSecondInstance = vi.fn()

    expect(acquireSingleInstanceLock(app, onSecondInstance)).toBe(false)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(app.on).not.toHaveBeenCalled()
    expect(onSecondInstance).not.toHaveBeenCalled()
  })
})
