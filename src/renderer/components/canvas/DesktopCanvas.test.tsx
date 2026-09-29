import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { describe, expect, it } from 'vitest'
import type { DisplayInfo } from '@shared/ipc'
import type { Group } from '@shared/schema'
import { useLayoutStore } from '../../stores/layout'
import { useUiStore } from '../../stores/ui'
import {
  desktopItem,
  makeGroup,
  PRIMARY_INFO,
  seedCanvas,
  type SeedOptions
} from '../../test/canvas-fixtures'
import { installFakeBridge, type FakeBridge } from '../../test/fake-bridge'
import { ConfirmHost } from '../feedback/ConfirmDialog'
import { DesktopCanvas } from './DesktopCanvas'

const ITEMS = [
  desktopItem('1:1', 'Notes'),
  desktopItem('1:2', 'Code', { kind: 'app', ext: '.exe' }),
  desktopItem('1:3', 'Projects', { kind: 'folder' }),
  desktopItem('1:4', 'Docs', { kind: 'url', ext: '.url' })
]

function renderCanvas(
  seed: SeedOptions = {},
  info: DisplayInfo = PRIMARY_INFO
): {
  bridge: FakeBridge
  user: ReturnType<typeof userEvent.setup>
  rerender(info: DisplayInfo): void
} {
  const bridge = installFakeBridge()
  seedCanvas({ items: ITEMS, ...seed })
  const tree = (display: DisplayInfo): React.JSX.Element => (
    <main>
      <DesktopCanvas displayId={display.id} info={display} />
      <ConfirmHost />
    </main>
  )
  const { rerender } = render(tree(info))
  return { bridge, user: userEvent.setup(), rerender: (next) => rerender(tree(next)) }
}

const surface = (): HTMLElement => document.querySelector('[data-canvas-surface]') as HTMLElement
const displayGroups = (): Group[] => useLayoutStore.getState().layout.displays[0].groups

async function openCanvasMenu(at = { clientX: 700, clientY: 500 }): Promise<HTMLElement> {
  fireEvent.contextMenu(surface(), at)
  return screen.findByRole('menu')
}

describe('DesktopCanvas', () => {
  it('shows the loose icons at their positions and hides items that are not on disk', () => {
    renderCanvas({
      loose: { '1:1': { x: 0, y: 0 }, '1:2': { x: 96, y: 192 }, '9:9': { x: 0, y: 96 } }
    })
    const layer = screen.getByRole('listbox', { name: 'Desktop icons' })
    const options = within(layer).getAllByRole('option')
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual(['Notes', 'Code'])
    expect(within(layer).getByRole('option', { name: 'Code' })).toHaveStyle({
      left: '96px',
      top: '192px',
      width: '96px',
      height: '96px'
    })
  })

  it('stacks the groups by z', () => {
    renderCanvas({
      groups: [makeGroup('a', { title: 'Top', z: 9 }), makeGroup('b', { title: 'Bottom', z: 2 })]
    })
    expect(screen.getByRole('region', { name: 'Bottom' })).toHaveStyle({ zIndex: '1' })
    expect(screen.getByRole('region', { name: 'Top' })).toHaveStyle({ zIndex: '2' })
  })

  it('raising a group never moves its element in the DOM (a moved node loses the click: the chevron needed two)', () => {
    renderCanvas({
      groups: [
        makeGroup('a', { title: 'Under', z: 1, x: 40 }),
        makeGroup('b', { title: 'Over', z: 2, x: 400 })
      ]
    })
    const under = screen.getByRole('region', { name: 'Under' })
    const parent = under.parentElement!
    const before = [...parent.children]
    const moves: MutationRecord[] = []
    const observer = new MutationObserver((records) => moves.push(...records))
    observer.observe(parent, { childList: true })

    // The press that starts a click on Under's chevron raises it (pointerdown, capture).
    const chevron = within(under).getByRole('button', { name: 'Roll up' })
    fireEvent.pointerDown(chevron, { button: 0 })
    moves.push(...observer.takeRecords())
    observer.disconnect()

    expect(under).toHaveStyle({ zIndex: '2' })
    expect(screen.getByRole('region', { name: 'Over' })).toHaveStyle({ zIndex: '1' })
    expect(moves).toEqual([])
    expect([...parent.children]).toEqual(before)
    fireEvent.click(chevron)
    expect(displayGroups().find((group) => group.id === 'a')?.rolledUp).toBe(true)
  })

  it('offers the desktop menu', async () => {
    renderCanvas()
    const menu = await openCanvasMenu()
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual([
      'New group here',
      'Auto-organize…',
      'Sort loose icons',
      'Hide tools widget',
      'Refresh desktop',
      'Settings',
      'Display settings',
      'Personalize',
      'Quit'
    ])
  })

  it('New group here creates a 280 × 200 group at the click point with its rename open', async () => {
    const { user } = renderCanvas()
    const menu = await openCanvasMenu({ clientX: 701, clientY: 499 })
    await user.click(within(menu).getByRole('menuitem', { name: 'New group here' }))

    expect(displayGroups()).toEqual([
      expect.objectContaining({ title: 'New group', x: 704, y: 496, w: 280, h: 200 })
    ])
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Rename group New group' })).toHaveFocus()
    )
    await user.keyboard('Inbox{Enter}')
    expect(displayGroups()[0].title).toBe('Inbox')
  })

  it('a new group near the edge stays inside the work area', async () => {
    const { user } = renderCanvas()
    const menu = await openCanvasMenu({ clientX: 2500, clientY: 1380 })
    await user.click(within(menu).getByRole('menuitem', { name: 'New group here' }))
    expect(displayGroups()[0]).toMatchObject({ x: 2560 - 280, y: 1392 - 200 })
  })

  it('Refresh, Settings, Display settings, Personalize and Quit do what they say', async () => {
    const { bridge, user } = renderCanvas()
    const pick = async (name: string): Promise<void> => {
      const menu = await openCanvasMenu()
      await user.click(within(menu).getByRole('menuitem', { name }))
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    }

    await pick('Refresh desktop')
    expect(bridge.desktop.rescan).toHaveBeenCalledOnce()
    await pick('Settings')
    expect(useUiStore.getState().inspectorOpen).toBe(true)
    await pick('Display settings')
    await pick('Personalize')
    expect(bridge.app.openExternal.mock.calls).toEqual([
      ['ms-settings:display'],
      ['ms-settings:personalization-background']
    ])
    await pick('Quit')
    expect(bridge.app.quit).toHaveBeenCalledOnce()
  })

  it('Sort loose icons lays the loose icons out by name, column-first', async () => {
    const { user } = renderCanvas({
      loose: { '1:1': { x: 500, y: 500 }, '1:2': { x: 0, y: 0 }, '1:4': { x: 900, y: 0 } }
    })
    const menu = await openCanvasMenu()
    await user.click(within(menu).getByRole('menuitem', { name: 'Sort loose icons' }))
    expect(useLayoutStore.getState().layout.displays[0].loose).toEqual({
      '1:2': { x: 0, y: 0 },
      '1:4': { x: 0, y: 96 },
      '1:1': { x: 0, y: 192 }
    })
  })

  it('Auto-organize… asks, then groups the loose icons by type', async () => {
    const { user } = renderCanvas({
      loose: {
        '1:1': { x: 0, y: 0 },
        '1:2': { x: 0, y: 96 },
        '1:3': { x: 0, y: 192 },
        '1:4': { x: 0, y: 288 }
      }
    })
    const menu = await openCanvasMenu()
    await user.click(within(menu).getByRole('menuitem', { name: 'Auto-organize…' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Auto-organize this desktop?' })
    await user.click(within(dialog).getByRole('button', { name: 'Auto-organize' }))

    expect(displayGroups().map((g) => [g.title, g.items])).toEqual([
      ['Apps', ['1:2']],
      ['Files', ['1:1']],
      ['Folders', ['1:3']],
      ['Web links', ['1:4']]
    ])
    expect(useLayoutStore.getState().layout.displays[0].loose).toEqual({})
  })

  describe('empty-desktop hint', () => {
    it('shows a hint card with Auto-organize while the desktop has icons but no groups', async () => {
      const { user } = renderCanvas({ loose: { '1:1': { x: 0, y: 0 }, '1:2': { x: 0, y: 96 } } })
      const card = screen.getByRole('region', { name: 'Tidy up your desktop' })
      expect(card).toHaveClass('glass')
      await user.click(within(card).getByRole('button', { name: 'Auto-organize' }))

      expect(displayGroups().map((g) => g.title)).toEqual(['Apps', 'Files'])
      expect(screen.queryByRole('region', { name: 'Tidy up your desktop' })).toBeNull()
    })

    it('Not now hides it for this session', async () => {
      const { user } = renderCanvas({ loose: { '1:1': { x: 0, y: 0 } } })
      await user.click(screen.getByRole('button', { name: 'Not now' }))
      expect(screen.queryByRole('region', { name: 'Tidy up your desktop' })).toBeNull()
      expect(useUiStore.getState().hintDismissed).toBe(true)
    })

    it('does not show once a group exists, or on a display without icons', () => {
      renderCanvas({ loose: { '1:1': { x: 0, y: 0 } }, groups: [makeGroup('g')] })
      expect(screen.queryByRole('region', { name: 'Tidy up your desktop' })).toBeNull()
    })

    it('does not show on an empty display', () => {
      renderCanvas()
      expect(screen.queryByRole('region', { name: 'Tidy up your desktop' })).toBeNull()
    })
  })

  describe('quick-hide', () => {
    it('double-clicking the empty desktop hides icons and groups, except excluded groups', async () => {
      const { user } = renderCanvas({
        loose: { '1:1': { x: 0, y: 0 } },
        groups: [
          makeGroup('a', { title: 'Hidden' }),
          makeGroup('b', { title: 'Pinned', x: 400, excludeFromQuickHide: true })
        ]
      })
      await user.dblClick(surface())
      expect(useUiStore.getState().quickHidden).toBe(true)
      expect(screen.queryByRole('listbox', { name: 'Desktop icons' })).toBeNull()
      expect(screen.queryByRole('region', { name: 'Hidden' })).toBeNull()
      expect(screen.getByRole('region', { name: 'Pinned' })).toBeInTheDocument()

      await user.dblClick(surface())
      expect(useUiStore.getState().quickHidden).toBe(false)
      expect(screen.getByRole('region', { name: 'Hidden' })).toBeInTheDocument()
    })

    it('does nothing when the setting is off', async () => {
      const { user } = renderCanvas({ settings: { quickHideOnDoubleClick: false } })
      await user.dblClick(surface())
      expect(useUiStore.getState().quickHidden).toBe(false)
    })
  })

  it('pulls groups back inside when the work area shrinks (taskbar moved, DPI change)', () => {
    const { rerender } = renderCanvas({
      groups: [makeGroup('g', { x: 2200, y: 1100, w: 300, h: 200 })]
    })
    expect(displayGroups()[0]).toMatchObject({ x: 2200, y: 1100 })
    const smaller = { ...PRIMARY_INFO, workArea: { x: 0, y: 0, width: 2400, height: 1200 } }
    act(() => rerender(smaller))
    expect(displayGroups()[0]).toMatchObject({ x: 2100, y: 1000, w: 300, h: 200 })
  })

  describe('snapping (round 2)', () => {
    const title = (name: string): HTMLElement =>
      within(screen.getByRole('region', { name })).getByRole('heading', { name })
    const guides = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('[data-snap-guide]')].map(
        (line) => line.dataset.snapGuide!
      )
    const drag = (
      target: HTMLElement,
      from: { x: number; y: number },
      to: { x: number; y: number },
      altKey = false
    ): void => {
      fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: from.x, clientY: from.y })
      fireEvent.pointerMove(target, { pointerId: 1, clientX: to.x, clientY: to.y, altKey })
    }
    const release = (target: HTMLElement, at: { x: number; y: number }): void => {
      fireEvent.pointerUp(target, { pointerId: 1, clientX: at.x, clientY: at.y })
    }
    // Neighbour: 600..880 × 400..600.
    const neighbours = (): SeedOptions => ({
      groups: [
        makeGroup('a', { title: 'Moving', x: 40, y: 40, z: 1 }),
        makeGroup('b', { title: 'Still', x: 600, y: 400, z: 2 })
      ]
    })

    it('a moving group is pulled onto a neighbour’s edges within 8 px, with guide lines until release', () => {
      renderCanvas(neighbours())
      const bar = title('Moving')
      // Left edge 40 + 845 = 885 (5 px from the neighbour's right edge); top 40 + 357 = 397.
      drag(bar, { x: 100, y: 50 }, { x: 945, y: 407 })
      expect(screen.getByRole('region', { name: 'Moving' })).toHaveStyle({
        left: '880px',
        top: '400px'
      })
      expect(guides()).toEqual(expect.arrayContaining(['x:880', 'y:400']))

      release(bar, { x: 945, y: 407 })
      expect(displayGroups().find((group) => group.id === 'a')).toMatchObject({ x: 880, y: 400 })
      expect(guides()).toEqual([])
    })

    it('holding Alt moves freely: no magnet, no grid, no guides', () => {
      renderCanvas(neighbours())
      const bar = title('Moving')
      drag(bar, { x: 100, y: 50 }, { x: 945, y: 407 }, true)
      expect(guides()).toEqual([])
      release(bar, { x: 945, y: 407 })
      expect(displayGroups().find((group) => group.id === 'a')).toMatchObject({ x: 885, y: 397 })
    })

    it('away from other edges it moves in the chosen grid step', () => {
      renderCanvas({ ...neighbours(), settings: { gridSize: 32 } })
      const bar = title('Moving')
      drag(bar, { x: 100, y: 50 }, { x: 195, y: 131 })
      release(bar, { x: 195, y: 131 })
      // 40 + 95 = 135 → 128; 40 + 81 = 121 → 128.
      expect(displayGroups().find((group) => group.id === 'a')).toMatchObject({ x: 128, y: 128 })
    })

    it('a resized edge is pulled onto a neighbour’s edge', () => {
      renderCanvas(neighbours())
      const east = screen
        .getByRole('region', { name: 'Moving' })
        .querySelector<HTMLElement>('[data-resize-edge="e"]')!
      // East edge 320 + 283 = 603 → the neighbour's left edge, 600.
      drag(east, { x: 318, y: 140 }, { x: 601, y: 140 })
      expect(guides()).toEqual(['x:600'])
      release(east, { x: 601, y: 140 })
      expect(displayGroups().find((group) => group.id === 'a')).toMatchObject({ x: 40, w: 560 })
      expect(guides()).toEqual([])
    })
  })

  describe('rolling down (round 2, Fences-style)', () => {
    it('a rolled-up bar can sit at the bottom; rolled down it grows upward and comes to the front', async () => {
      const { user } = renderCanvas({
        groups: [
          makeGroup('a', { title: 'Low', x: 40, y: 100, h: 300, z: 1, rolledUp: true }),
          makeGroup('b', { title: 'Over', x: 40, y: 900, z: 2 })
        ]
      })
      const bar = within(screen.getByRole('region', { name: 'Low' })).getByRole('heading', {
        name: 'Low'
      })
      // Only the 36 px bar has to stay inside: it can go down to 1392 − 36 = 1356.
      fireEvent.pointerDown(bar, { button: 0, pointerId: 1, clientX: 100, clientY: 110 })
      fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100, clientY: 1500 })
      fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100, clientY: 1500 })
      expect(displayGroups()[0]).toMatchObject({ y: 1356, h: 300, rolledUp: true })

      // Raise the other group, then one click on the chevron rolls Low down, upward and on top.
      fireEvent.pointerDown(
        within(screen.getByRole('region', { name: 'Over' })).getByRole('heading')
      )
      await user.click(
        within(screen.getByRole('region', { name: 'Low' })).getByRole('button', {
          name: 'Roll down'
        })
      )
      expect(displayGroups()[0]).toMatchObject({ rolledUp: false, y: 1092, h: 300 })
      expect(screen.getByRole('region', { name: 'Low' })).toHaveStyle({
        top: '1092px',
        height: '300px',
        zIndex: '2'
      })
    })

    it('the menu’s Roll down and a double-click on the title do the same', async () => {
      const { user } = renderCanvas({
        groups: [makeGroup('a', { title: 'Low', x: 40, y: 1300, h: 300, rolledUp: true })]
      })
      await user.dblClick(
        within(screen.getByRole('region', { name: 'Low' })).getByRole('heading', { name: 'Low' })
      )
      expect(displayGroups()[0]).toMatchObject({ rolledUp: false, y: 1092 })
      await user.dblClick(
        within(screen.getByRole('region', { name: 'Low' })).getByRole('heading', { name: 'Low' })
      )
      expect(displayGroups()[0]).toMatchObject({ rolledUp: true, y: 1092 })
      fireEvent.contextMenu(
        within(screen.getByRole('region', { name: 'Low' })).getByRole('heading', { name: 'Low' })
      )
      await user.click(await screen.findByRole('menuitem', { name: 'Roll down' }))
      expect(displayGroups()[0]).toMatchObject({ rolledUp: false, y: 1092 })
    })
  })

  it('has no detectable accessibility violations', async () => {
    renderCanvas({
      loose: { '1:1': { x: 0, y: 0 } },
      groups: [makeGroup('g', { x: 400, items: ['1:2'] })]
    })
    expect(await axe(document.body)).toHaveNoViolations()
  })
})
