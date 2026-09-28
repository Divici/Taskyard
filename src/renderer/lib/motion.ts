import { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settings'

// Phase 12 motion: the `css-reveal` entrance from the design-pattern library
// (scroll-choreography/01-reveals.md) applied to groups on launch. JS only moves a group through
// its phases (a data attribute); styles/motion.css does the animating, from the verbatim motion
// budget in motion-variables.css (--transition, --set-opacity). The kill switch — Settings ›
// Reduce motion (`reduce-motion` on <html>) or Windows' "Animation effects" off — resets every
// group to its FINAL state, never the hidden one (00-architecture.md § motion-kill-switch).

/** Delay between two groups' entrances, in reading order (`--i` × this). */
export const REVEAL_STAGGER_MS = 40
/** One entrance: motion-variables.css `--transition` (0.7 s). */
export const REVEAL_DURATION_MS = 700
/** Groups that mount this long after the canvas first had its layout still enter; later ones appear at once. */
export const LAUNCH_REVEAL_WINDOW_MS = 1_000

/**
 * - `hidden`: the css-reveal from-state (faded out, a few px low), painted for two frames;
 * - `shown`: transitioning to the final state (`is-show` in the pattern);
 * - `settled`: final state with the quick hover/roll-up transitions.
 */
export type RevealPhase = 'hidden' | 'shown' | 'settled'

/** Windows' "Animation effects" off, as Chromium reports it (false where matchMedia is missing). */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  } catch {
    return false
  }
}

/**
 * The entrance phase of one group. `index` is its place in the launch order, or undefined for a
 * group that was not there at launch (it appears settled). The kill switch settles it at once,
 * even mid-entrance.
 */
export function useEntrance(index: number | undefined): RevealPhase {
  const killSwitch = useSettingsStore((state) => state.settings.reduceMotion)
  const [phase, setPhase] = useState<RevealPhase>(() =>
    index === undefined || killSwitch || prefersReducedMotion() ? 'settled' : 'hidden'
  )

  useEffect(() => {
    if (phase === 'hidden') {
      // Two frames: the first lets the hidden state be styled, the second paints it, so the
      // change to `shown` is a real transition rather than the first style the node ever had.
      let second = 0
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setPhase('shown'))
      })
      return () => {
        cancelAnimationFrame(first)
        cancelAnimationFrame(second)
      }
    }
    if (phase === 'shown') {
      const timer = setTimeout(
        () => setPhase('settled'),
        REVEAL_DURATION_MS + (index ?? 0) * REVEAL_STAGGER_MS + 50
      )
      return () => clearTimeout(timer)
    }
    return undefined
  }, [phase, index])

  return killSwitch ? 'settled' : phase
}

interface Positioned {
  id: string
  x: number
  y: number
}

/** Reading order (top to bottom, then left to right): each id's entrance index. */
export function revealOrder(groups: readonly Positioned[]): Map<string, number> {
  const sorted = [...groups].sort((a, b) => a.y - b.y || a.x - b.x)
  return new Map(sorted.map((group, index) => [group.id, index]))
}
