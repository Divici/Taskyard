import { useEffect, useRef } from 'react'
import { normalizeRect, rectCenter, rectContainsPoint, rectsIntersect } from '@shared/geometry'
import type { Point, Rect } from '@shared/schema'
import { useUiStore } from '../../stores/ui'

/** A press on the empty desktop becomes a marquee once the pointer has moved this far (px). */
export const MARQUEE_THRESHOLD = 4

/** How long after a right-button drag its `contextmenu` event is waited for (ms). */
export const CONTEXT_MENU_SWALLOW_MS = 500

/**
 * Windows sends `contextmenu` when the right button comes up, to whatever is under the pointer
 * then — after a right-drag often the group just drawn, or an icon. That one event must open no
 * menu anywhere: a capture listener on `window` runs before React (and Radix) see it, stops it,
 * and removes itself. It also goes away on the next press or after a short timeout, so a later
 * right-click always works. Returns the disarm function.
 */
function swallowNextContextMenu(): () => void {
  const disarm = (): void => {
    window.removeEventListener('contextmenu', swallow, true)
    window.removeEventListener('pointerdown', disarm, true)
    clearTimeout(timer)
  }
  const swallow = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
    disarm()
  }
  window.addEventListener('contextmenu', swallow, true)
  window.addEventListener('pointerdown', disarm, true)
  const timer = setTimeout(disarm, CONTEXT_MENU_SWALLOW_MS)
  return disarm
}

export interface MarqueeTarget {
  id: string
  rect: Rect
}

export interface MarqueeOptions {
  /** The loose icons on this display (their cells, window coordinates). */
  targets: readonly MarqueeTarget[]
  /** Right-button drag released: draw a group with these bounds holding `ids` (fully inside). */
  onDrawGroup(rect: Rect, ids: string[]): void
}

export interface MarqueeApi {
  /** Spread on the canvas surface. */
  handlers: {
    /** The press; its moves and release are followed on `window` until the button comes up. */
    onPointerDown(event: React.PointerEvent<HTMLElement>): void
  }
}

/** The parts of a pointer event the band needs (React's or a native one). */
type PointerAt = Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>

interface Press {
  pointerId: number
  button: number
  origin: Point
  additive: boolean
  base: string[]
  dragging: boolean
}

/**
 * The rubber band on the empty desktop. Left button: selects the icons it touches (Ctrl adds to
 * the selection), like Explorer; a plain click clears the selection. Right button: draws a new
 * group ("draw a group like Fences") that captures the icons inside it. The band itself is in the
 * ui store (`marquee`) and drawn by `<Marquee />`.
 */
export function useMarquee({ targets, onDrawGroup }: MarqueeOptions): MarqueeApi {
  const press = useRef<Press | null>(null)
  const disarmSwallow = useRef<(() => void) | null>(null)
  /** Stops following the press on `window`, if one is on. */
  const unfollow = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      disarmSwallow.current?.()
      unfollow.current?.()
    },
    []
  )

  const bandFor = (event: PointerAt, origin: Point): Rect =>
    normalizeRect(origin, { x: event.clientX, y: event.clientY })

  const touched = (band: Rect): string[] =>
    targets.filter((target) => rectsIntersect(target.rect, band)).map((target) => target.id)

  const inside = (band: Rect): string[] =>
    targets
      .filter((target) => rectContainsPoint(band, rectCenter(target.rect)))
      .map((target) => target.id)

  const end = (event: PointerAt, surface: Element | null): Press | null => {
    const current = press.current
    if (!current || current.pointerId !== event.pointerId) return null
    press.current = null
    unfollow.current?.()
    unfollow.current = null
    if (surface?.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId)
    useUiStore.getState().setMarquee(null)
    return current
  }

  const move = (event: PointerAt): void => {
    const current = press.current
    if (!current || current.pointerId !== event.pointerId) return
    const band = bandFor(event, current.origin)
    if (!current.dragging) {
      if (Math.max(band.width, band.height) < MARQUEE_THRESHOLD) return
      current.dragging = true
    }
    const ui = useUiStore.getState()
    ui.setMarquee(band)
    if (current.button === 0) {
      ui.select([...new Set([...current.base, ...touched(band)])])
    }
  }

  const release = (event: PointerAt, surface: Element | null): void => {
    const current = end(event, surface)
    if (!current) return
    const band = bandFor(event, current.origin)
    if (!current.dragging) {
      if (current.button === 0 && !current.additive) useUiStore.getState().clearSelection()
      return
    }
    if (current.button === 2) {
      disarmSwallow.current?.()
      disarmSwallow.current = swallowNextContextMenu()
      onDrawGroup(band, inside(band))
    } else {
      useUiStore.getState().select([...new Set([...current.base, ...touched(band)])])
    }
  }

  /**
   * Follows the press on `window` (capture phase) rather than on the surface alone: the surface
   * takes the pointer capture, but Chromium can drop a capture without a trace (measured in the
   * Phase 12 e2e: a right-drag begun right after the page loaded got neither gotpointercapture
   * nor lostpointercapture, and its pointerup landed on an icon, which opened the icon's menu).
   * Every pointer event reaches `window` whatever it targets, so the band always finishes.
   */
  const follow = (pointerId: number, surface: Element): void => {
    unfollow.current?.()
    const mine = (e: PointerEvent): boolean => e.pointerId === pointerId
    const onMove = (e: PointerEvent): void => {
      if (mine(e)) move(e)
    }
    const onUp = (e: PointerEvent): void => {
      if (mine(e)) release(e, surface)
    }
    const onCancel = (e: PointerEvent): void => {
      if (mine(e)) end(e, surface)
    }
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
    unfollow.current = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
    }
  }

  return {
    handlers: {
      onPointerDown(event) {
        if (event.button !== 0 && event.button !== 2) return
        event.currentTarget.setPointerCapture(event.pointerId)
        const additive = event.ctrlKey || event.metaKey
        press.current = {
          pointerId: event.pointerId,
          button: event.button,
          origin: { x: event.clientX, y: event.clientY },
          additive,
          base: additive ? [...useUiStore.getState().selection] : [],
          dragging: false
        }
        follow(event.pointerId, event.currentTarget)
      }
    }
  }
}
