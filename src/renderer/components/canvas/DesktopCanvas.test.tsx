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

  it('has no detectable accessibility violations', async () => {
    renderCanvas({
      loose: { '1:1': { x: 0, y: 0 } },
      groups: [makeGroup('g', { x: 400, items: ['1:2'] })]
    })
    expect(await axe(document.body)).toHaveNoViolations()
  })
})
