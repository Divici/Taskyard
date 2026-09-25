import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import type { DesktopItem, Group } from '@shared/schema'
import { desktopItem, PRIMARY_INFO, seedCanvas } from '../../test/canvas-fixtures'
import { mockRect } from '../../test/dnd-rects'
import { installFakeBridge, type FakeBridge } from '../../test/fake-bridge'
import { DesktopCanvas } from '../canvas/DesktopCanvas'

export const NOTES = desktopItem('1:1', 'Notes')

export interface DesktopSetup {
  bridge: FakeBridge
  icon(name: string): HTMLElement
}

/**
 * The primary display's canvas with `items` (Notes loose at the origin by default). dnd-kit
 * measures through getBoundingClientRect, which jsdom reports as 0×0: every loose icon and the
 * canvas drop zone get real rects.
 */
export function renderDesktop({
  items = [NOTES],
  loose = { '1:1': { x: 0, y: 0 } },
  groups = []
}: {
  items?: DesktopItem[]
  loose?: Record<string, { x: number; y: number }>
  groups?: Group[]
} = {}): DesktopSetup {
  const bridge = installFakeBridge()
  seedCanvas({ items, loose, groups })
  render(
    createElement('main', null, createElement(DesktopCanvas, { displayId: 1, info: PRIMARY_INFO }))
  )
  const zone = document.querySelector('[data-canvas-drop]')
  if (zone) mockRect(zone, { width: 2560, height: 1392 })
  for (const [id, point] of Object.entries(loose)) {
    const element = document.querySelector(`[data-item-id="${id}"]`)
    if (element) mockRect(element, { ...point, width: 96, height: 96 })
  }
  return {
    bridge,
    icon: (name) => screen.getByRole('option', { name })
  }
}

/** A primary-button press on `element` at (x, y). */
export function press(element: Element, x: number, y: number): void {
  fireEvent.pointerDown(element, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: x,
    clientY: y
  })
}

/** dnd-kit follows the pointer on the document once pressed. */
export function moveTo(x: number, y: number): void {
  fireEvent.pointerMove(document, { pointerId: 1, isPrimary: true, clientX: x, clientY: y })
}

export function release(x: number, y: number): void {
  fireEvent.pointerUp(document, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: x,
    clientY: y
  })
}

export const overlay = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-drag-overlay]')
