import { describe, expect, it, vi } from 'vitest'
import { playChime, type AudioContextLike } from './chime'

function fakeContext(): AudioContextLike & { oscillators: Array<Record<string, unknown>> } {
  const oscillators: Array<Record<string, unknown>> = []
  const param = (): Record<string, unknown> => ({
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn()
  })
  return {
    currentTime: 10,
    destination: {} as AudioNode,
    oscillators,
    createOscillator: () => {
      const listeners: Array<() => void> = []
      const oscillator = {
        type: '',
        frequency: param(),
        connect: vi.fn(),
        start: vi.fn(),
        // The note ends as soon as it is scheduled to stop (no real clock here).
        stop: vi.fn(() => queueMicrotask(() => listeners.forEach((listener) => listener()))),
        addEventListener: (_: string, listener: () => void) => listeners.push(listener)
      }
      oscillators.push(oscillator)
      return oscillator as unknown as OscillatorNode
    },
    createGain: () => ({ gain: param(), connect: vi.fn() }) as unknown as GainNode,
    close: vi.fn(async () => {})
  }
}

describe('playChime', () => {
  it('plays two sine notes and closes its audio context when they end', async () => {
    const context = fakeContext()

    await playChime(() => context)

    expect(context.oscillators).toHaveLength(2)
    for (const oscillator of context.oscillators) {
      expect(oscillator['type']).toBe('sine')
      expect(oscillator['start']).toHaveBeenCalledOnce()
      expect(oscillator['stop']).toHaveBeenCalledOnce()
    }
    expect(context.close).toHaveBeenCalledOnce()
  })

  it('stays quiet (never throws) when there is no audio output', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      playChime(() => {
        throw new Error('no audio device')
      })
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })
})
