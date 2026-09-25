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
    onPointerDown(event: React.PointerEvent<HTMLElement>): void
    onPointerMove(event: React.PointerEvent<HTMLElement>): void
    onPointerUp(event: React.PointerEvent<HTMLElement>): void
    onPointerCancel(event: React.PointerEvent<HTMLElement>): void
  }
}

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
  useEffect(() => () => disarmSwallow.current?.(), [])

  const bandFor = (event: React.PointerEvent, origin: Point): Rect =>
    normalizeRect(origin, { x: event.clientX, y: event.clientY })

  const touched = (band: Rect): string[] =>
    targets.filter((target) => rectsIntersect(target.rect, band)).map((target) => target.id)

  const inside = (band: Rect): string[] =>
    targets
      .filter((target) => rectContainsPoint(band, rectCenter(target.rect)))
      .map((target) => target.id)

  const end = (event: React.PointerEvent<HTMLElement>): Press | null => {
    const current = press.current
    if (!current || current.pointerId !== event.pointerId) return null
    press.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    useUiStore.getState().setMarquee(null)
    return current
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
      },
      onPointerMove(event) {
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
      },
      onPointerUp(event) {
        const current = end(event)
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
      },
      onPointerCancel(event) {
        end(event)
      }
    }
  }
}
