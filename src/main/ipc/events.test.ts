import { describe, expect, it, vi } from 'vitest'
import { createEventEmitter, type WebContentsLike } from './events'

function contents(
  id: number,
  destroyed = false
): WebContentsLike & { send: ReturnType<typeof vi.fn> } {
  return { id, isDestroyed: () => destroyed, send: vi.fn() }
}

const quiet = { warn: vi.fn() }

describe('createEventEmitter', () => {
  it('sends the event to every live renderer', () => {
    const a = contents(1)
    const b = contents(2)
    const emitter = createEventEmitter(() => [a, b], quiet)

    const delivered = emitter.emit('peek:changed', { peeking: true })

    expect(delivered).toBe(2)
    expect(a.send).toHaveBeenCalledExactlyOnceWith('peek:changed', { peeking: true })
    expect(b.send).toHaveBeenCalledExactlyOnceWith('peek:changed', { peeking: true })
  })

  it('skips destroyed renderers', () => {
    const live = contents(1)
    const dead = contents(2, true)
    const emitter = createEventEmitter(() => [live, dead], quiet)

    expect(emitter.emit('desktop:renamed', { id: '1:2', path: 'C:\\x' })).toBe(1)
    expect(dead.send).not.toHaveBeenCalled()
  })

  it('has no way to skip a renderer: every window, a save’s sender included, gets the event', () => {
    const sender = contents(1)
    const other = contents(2)
    const emitter = createEventEmitter(() => [sender, other], quiet)
    const emit = emitter.emit as (event: string, payload: unknown, options: unknown) => number

    const delivered = emit(
      'desktop:changed',
      { added: [], removed: [], changed: [] },
      {
        exceptSenderId: 1
      }
    )

    expect(delivered).toBe(2)
    expect(sender.send).toHaveBeenCalledOnce()
    expect(other.send).toHaveBeenCalledOnce()
  })

  it('reads the current renderers on every emit', () => {
    const list: WebContentsLike[] = []
    const emitter = createEventEmitter(() => list, quiet)

    expect(emitter.emit('peek:changed', { peeking: false })).toBe(0)
    list.push(contents(1))
    expect(emitter.emit('peek:changed', { peeking: false })).toBe(1)
  })

  it('a window whose send throws is logged and skipped; the others still get the event', () => {
    const broken = {
      id: 1,
      isDestroyed: () => false,
      send: vi.fn(() => {
        throw new Error('render frame disposed')
      })
    }
    const healthy = contents(2)
    const log = { warn: vi.fn() }
    const emitter = createEventEmitter(() => [broken, healthy], log)

    expect(() => emitter.emit('peek:changed', { peeking: true })).not.toThrow()

    expect(healthy.send).toHaveBeenCalledOnce()
    expect(log.warn).toHaveBeenCalledWith(
      'ipc: sending peek:changed to window 1 failed',
      expect.objectContaining({ message: 'render frame disposed' })
    )
  })
})

describe('createEventEmitter over desktop windows (custom targets)', () => {
  interface Win {
    displayId: number
    contents: (WebContentsLike & { send: ReturnType<typeof vi.fn> }) | null
  }
  const win = (displayId: number, destroyed = false): Win => ({
    displayId,
    contents: destroyed ? null : contents(displayId)
  })

  it('broadcasts one payload to every target that still has live contents', () => {
    const a = win(1)
    const gone = win(2, true)
    const b = win(3)
    const emitter = createEventEmitter(
      () => [a, gone, b],
      (w) => w.contents,
      quiet
    )

    expect(emitter.emit('peek:changed', { peeking: true })).toBe(2)
    expect(a.contents!.send).toHaveBeenCalledExactlyOnceWith('peek:changed', { peeking: true })
    expect(b.contents!.send).toHaveBeenCalledExactlyOnceWith('peek:changed', { peeking: true })
  })

  it('sends each target its own payload and skips a target whose payload is null', () => {
    const a = win(1)
    const b = win(2)
    const unknown = win(3)
    const emitter = createEventEmitter(
      () => [a, b, unknown],
      (w) => w.contents,
      quiet
    )
    const rect = { x: 0, y: 0, width: 10, height: 10 }

    const delivered = emitter.emitEach('display:changed', (w) =>
      w.displayId === 3
        ? null
        : { id: w.displayId, bounds: rect, workArea: rect, scaleFactor: w.displayId }
    )

    expect(delivered).toBe(2)
    expect(a.contents!.send).toHaveBeenCalledExactlyOnceWith(
      'display:changed',
      expect.objectContaining({ id: 1, scaleFactor: 1 })
    )
    expect(b.contents!.send).toHaveBeenCalledExactlyOnceWith(
      'display:changed',
      expect.objectContaining({ id: 2, scaleFactor: 2 })
    )
    expect(unknown.contents!.send).not.toHaveBeenCalled()
  })

  it('sends to one target with the same isolation (a failing send is logged, not thrown)', () => {
    const a = win(1)
    a.contents!.send.mockImplementation(() => {
      throw new Error('render frame disposed')
    })
    const log = { warn: vi.fn() }
    const emitter = createEventEmitter(
      () => [a],
      (w) => w.contents,
      log
    )

    expect(emitter.emitTo(a, 'peek:changed', { peeking: false })).toBe(false)
    expect(emitter.emitTo(win(2, true), 'peek:changed', { peeking: false })).toBe(false)
    expect(log.warn).toHaveBeenCalledOnce()
    const b = win(4)
    expect(emitter.emitTo(b, 'peek:changed', { peeking: false })).toBe(true)
    expect(b.contents!.send).toHaveBeenCalledExactlyOnceWith('peek:changed', { peeking: false })
  })
})
