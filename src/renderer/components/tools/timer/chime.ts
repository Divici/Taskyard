/** The slice of the Web Audio API the chime uses (injectable for tests). */
export interface AudioContextLike {
  readonly currentTime: number
  readonly destination: AudioNode
  createOscillator(): OscillatorNode
  createGain(): GainNode
  close(): Promise<void>
}

/** Two soft sine notes (E6 then A6), a gentle "done" rather than an alarm. */
const NOTES = [
  { frequency: 1318.51, start: 0, length: 0.45 },
  { frequency: 1760, start: 0.18, length: 0.6 }
] as const

const PEAK_GAIN = 0.18

/**
 * Plays the timer's short chime through Web Audio (no audio file to ship). Resolves when it has
 * finished and the context is closed; never throws (a machine without audio output just stays
 * quiet). Gated by Settings › Timer sound in the caller.
 */
export async function playChime(
  createContext: () => AudioContextLike = () => new AudioContext()
): Promise<void> {
  let context: AudioContextLike
  try {
    context = createContext()
  } catch (error) {
    console.warn('timer: no audio output for the chime', error)
    return
  }
  try {
    const at = context.currentTime
    const ends = NOTES.map(({ frequency, start, length }) => {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, at + start)
      gain.gain.setValueAtTime(0, at + start)
      gain.gain.linearRampToValueAtTime(PEAK_GAIN, at + start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + start + length)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(at + start)
      oscillator.stop(at + start + length)
      return new Promise<void>((resolve) => oscillator.addEventListener('ended', () => resolve()))
    })
    await Promise.all(ends)
  } catch (error) {
    console.warn('timer: the chime failed', error)
  } finally {
    await context.close().catch(() => {})
  }
}
