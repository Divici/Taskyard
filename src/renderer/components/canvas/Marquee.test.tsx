import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useLayoutStore } from '../../stores/layout'
import { useUiStore } from '../../stores/ui'
import { desktopItem, PRIMARY_INFO, seedCanvas } from '../../test/canvas-fixtures'
import { installFakeBridge } from '../../test/fake-bridge'
import { DesktopCanvas } from './DesktopCanvas'
import { CONTEXT_MENU_SWALLOW_MS } from './useMarquee'

// Loose cell at the medium icon size: 96 × 96.
const ITEMS = [desktopItem('1:1', 'a'), desktopItem('1:2', 'b'), desktopItem('1:3', 'c')]
const LOOSE = { '1:1': { x: 0, y: 0 }, '1:2': { x: 0, y: 96 }, '1:3': { x: 400, y: 400 } }

function renderCanvas(): HTMLElement {
  installFakeBridge()
  seedCanvas({ items: ITEMS, loose: LOOSE })
  render(
    <main>
      <DesktopCanvas displayId={1} info={PRIMARY_INFO} />
    </main>
  )
  return document.querySelector('[data-canvas-surface]') as HTMLElement
}

function drag(
  surface: HTMLElement,
  button: number,
  from: [number, number],
  to: [number, number]
): void {
  const init = { button, buttons: button === 2 ? 2 : 1, pointerId: 1, isPrimary: true }
  fireEvent.pointerDown(surface, { ...init, clientX: from[0], clientY: from[1] })
  fireEvent.pointerMove(surface, {
    ...init,
    clientX: (from[0] + to[0]) / 2,
    clientY: (from[1] + to[1]) / 2
  })
  fireEvent.pointerMove(surface, { ...init, clientX: to[0], clientY: to[1] })
}

function release(surface: HTMLElement, button: number, at: [number, number]): void {
  fireEvent.pointerUp(surface, { button, pointerId: 1, clientX: at[0], clientY: at[1] })
}

const groups = (): ReturnType<typeof useLayoutStore.getState>['layout']['displays'][0]['groups'] =>
  useLayoutStore.getState().layout.displays[0].groups

describe('Marquee', () => {
  it('draws the rubber band while dragging and selects the icons it touches (left button)', () => {
    const surface = renderCanvas()
    drag(surface, 0, [150, 150], [60, 60])

    const band = document.querySelector('[data-marquee]') as HTMLElement
    expect(band).toHaveStyle({ left: '60px', top: '60px', width: '90px', height: '90px' })
    expect(useUiStore.getState().marquee).toEqual({ x: 60, y: 60, width: 90, height: 90 })

    release(surface, 0, [60, 60])
    expect(useUiStore.getState().selection.sort()).toEqual(['1:1', '1:2'])
    expect(document.querySelector('[data-marquee]')).toBeNull()
    expect(groups()).toEqual([])
  })

  it('a right-button drag creates a group with the marquee bounds and the icons inside it', () => {
    const surface = renderCanvas()
    drag(surface, 2, [10, 10], [180, 200])
    release(surface, 2, [180, 200])

    expect(groups()).toHaveLength(1)
    // (10, 10)–(180, 200) snapped to the 8 px grid.
    expect(groups()[0]).toMatchObject({ x: 8, y: 8, w: 168, h: 192, items: ['1:1', '1:2'] })
    expect(useLayoutStore.getState().layout.displays[0].loose).toEqual({
      '1:3': { x: 400, y: 400 }
    })

    // Named like any new group, with its inline rename open.
    const region = screen.getByRole('region', { name: 'New group' })
    expect(within(region).getByRole('textbox', { name: 'Rename group New group' })).toHaveFocus()

    // The context menu that follows a right-drag does not open.
    fireEvent.contextMenu(surface, { clientX: 180, clientY: 200 })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('after a right-drag, the release’s context menu opens nowhere — not on the new group, not on an icon — and the rename stays open', () => {
    const surface = renderCanvas()
    // An up-left drag: the release lands inside the new (grown) group.
    drag(surface, 2, [200, 220], [120, 150])
    release(surface, 2, [120, 150])
    const region = screen.getByRole('region', { name: 'New group' })
    const input = within(region).getByRole('textbox', { name: 'Rename group New group' })
    expect(input).toHaveFocus()

    fireEvent.contextMenu(region, { clientX: 120, clientY: 150 })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(input).toHaveFocus()
  })

  it('swallows the release’s context menu on a loose icon too', () => {
    const surface = renderCanvas()
    drag(surface, 2, [600, 600], [700, 700])
    release(surface, 2, [700, 700])
    fireEvent.contextMenu(screen.getByRole('option', { name: 'c' }), { clientX: 420, clientY: 420 })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Rename group New group' })).toHaveFocus()
  })

  it('the next real right-click on the desktop opens the desktop menu', async () => {
    const surface = renderCanvas()
    drag(surface, 2, [600, 600], [700, 700])
    release(surface, 2, [700, 700])
    fireEvent.contextMenu(surface, { clientX: 700, clientY: 700 }) // the release's own event
    expect(screen.queryByRole('menu')).toBeNull()

    // A later right-click (a new press first).
    fireEvent.pointerDown(surface, { button: 2, pointerId: 2, clientX: 1500, clientY: 900 })
    fireEvent.pointerUp(surface, { button: 2, pointerId: 2, clientX: 1500, clientY: 900 })
    fireEvent.contextMenu(surface, { clientX: 1500, clientY: 900 })
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })

  it('the swallow expires on its own if no context menu event follows', async () => {
    vi.useFakeTimers()
    try {
      const surface = renderCanvas()
      drag(surface, 2, [600, 600], [700, 700])
      release(surface, 2, [700, 700])
      act(() => vi.advanceTimersByTime(CONTEXT_MENU_SWALLOW_MS + 1))
      fireEvent.contextMenu(surface, { clientX: 1500, clientY: 900 })
      expect(screen.getByRole('menu')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('grows a small right-drag to the minimum group size', () => {
    const surface = renderCanvas()
    drag(surface, 2, [600, 600], [640, 650])
    release(surface, 2, [640, 650])
    expect(groups()[0]).toMatchObject({ x: 600, y: 600, w: 160, h: 120, items: [] })
  })

  it('a click on the empty desktop (no drag) clears the selection and draws nothing', () => {
    const surface = renderCanvas()
    useUiStore.getState().select(['1:1'])
    drag(surface, 0, [700, 700], [701, 701])
    release(surface, 0, [701, 701])
    expect(useUiStore.getState().selection).toEqual([])
    expect(groups()).toEqual([])
  })

  it('Ctrl+drag adds to the selection', () => {
    const surface = renderCanvas()
    useUiStore.getState().select(['1:3'])
    const at = (clientX: number, clientY: number): PointerEventInit => ({
      button: 0,
      pointerId: 1,
      ctrlKey: true,
      clientX,
      clientY
    })
    fireEvent.pointerDown(surface, at(150, 20))
    fireEvent.pointerMove(surface, at(60, 50))
    fireEvent.pointerUp(surface, at(60, 50))
    expect(useUiStore.getState().selection.sort()).toEqual(['1:1', '1:3'])
  })
})
