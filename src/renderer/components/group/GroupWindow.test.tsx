import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { describe, expect, it, vi } from 'vitest'
import type { Group } from '@shared/schema'
import { useLayoutStore } from '../../stores/layout'
import { useUiStore } from '../../stores/ui'
import { desktopItem, makeGroup, PRIMARY_INFO, seedCanvas } from '../../test/canvas-fixtures'
import { installFakeBridge } from '../../test/fake-bridge'
import { ConfirmHost } from '../feedback/ConfirmDialog'
import { GroupWindow } from './GroupWindow'

const AREA = { x: 0, y: 0, width: 2560, height: 1392 }

const ITEMS = [
  desktopItem('1:1', 'zeta'),
  desktopItem('1:2', 'Alpha'),
  desktopItem('1:3', 'mid', { kind: 'folder' })
]

function currentGroup(id = 'g'): Group {
  return useLayoutStore.getState().layout.displays[0].groups.find((g) => g.id === id)!
}

function renderGroup(
  patch: Partial<Group> = {},
  wrap?: (node: React.ReactNode) => React.ReactNode
): {
  region: HTMLElement
  user: ReturnType<typeof userEvent.setup>
} {
  // Tests that need the bridge install their own first.
  if (!('taskyard' in window)) installFakeBridge()
  seedCanvas({
    items: ITEMS,
    groups: [makeGroup('g', { x: 100, y: 100, items: ['1:1', '1:2', '1:3'], ...patch })]
  })
  function Live(): React.JSX.Element | null {
    const group = useLayoutStore((state) => state.layout.displays[0].groups[0])
    return group ? <GroupWindow group={group} displayId={1} area={AREA} /> : null
  }
  const node = (
    <main>
      <Live />
      <ConfirmHost />
    </main>
  )
  render(wrap ? wrap(node) : node)
  return { region: screen.getByRole('region', { name: 'Work' }), user: userEvent.setup() }
}

const handle = (edge: string): HTMLElement =>
  document.querySelector(`[data-resize-edge="${edge}"]`) as HTMLElement

describe('GroupWindow', () => {
  it('is a glass region named by its title, at its rect, on top by its z', () => {
    const { region } = renderGroup({ z: 3 })
    expect(region).toHaveClass('glass')
    expect(region).toHaveStyle({ left: '100px', top: '100px', width: '280px', height: '200px' })
    expect(within(region).getByRole('heading', { name: 'Work' })).toBeInTheDocument()
    expect(region).toHaveAttribute('data-group-id', 'g')
  })

  it('lists its items in the group’s sort order', () => {
    const { region } = renderGroup({ sort: 'name' })
    const list = within(region).getByRole('listbox', { name: 'Work items' })
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.getAttribute('aria-label'))
    ).toEqual(['Alpha', 'mid', 'zeta'])
  })

  it('keeps manual order and hides ids that are not on the desktop (missing files)', () => {
    const { region } = renderGroup({ items: ['1:1', '9:9', '1:2'] })
    expect(
      within(region)
        .getAllByRole('option')
        .map((o) => o.getAttribute('aria-label'))
    ).toEqual(['zeta', 'Alpha'])
  })

  it('shows "Drop icons here" when empty', () => {
    const { region } = renderGroup({ items: [] })
    expect(within(region).getByText('Drop icons here')).toBeInTheDocument()
    expect(within(region).queryByRole('listbox')).toBeNull()
  })

  it('double-clicking the title rolls the group up to its 36 px header, keeping its width', async () => {
    const { region, user } = renderGroup()
    await user.dblClick(within(region).getByRole('heading', { name: 'Work' }))

    expect(currentGroup().rolledUp).toBe(true)
    expect(region).toHaveStyle({ height: '36px', width: '280px' })
    expect(within(region).queryByRole('listbox')).toBeNull()
    expect(currentGroup().h).toBe(200)

    await user.click(within(region).getByRole('button', { name: 'Roll down' }))
    expect(currentGroup().rolledUp).toBe(false)
    expect(within(region).getByRole('listbox')).toBeInTheDocument()
  })

  it('resizes with a pointer drag on a handle (snapped to 8 px) and saves once on release', async () => {
    const { region, user } = renderGroup()
    await user.pointer([
      { keys: '[MouseLeft>]', target: handle('se'), coords: { clientX: 380, clientY: 300 } },
      { coords: { clientX: 400, clientY: 330 } },
      { coords: { clientX: 421, clientY: 357 } }
    ])
    // Live while dragging, not saved yet: the edge (421, 357) snaps to (424, 360).
    expect(region).toHaveStyle({ width: '324px', height: '260px' })
    expect(currentGroup()).toMatchObject({ w: 280, h: 200 })

    await user.pointer({ keys: '[/MouseLeft]' })
    expect(currentGroup()).toMatchObject({ x: 100, y: 100, w: 324, h: 260 })
  })

  it('stops at the minimum size (160 × 120)', async () => {
    const { user } = renderGroup()
    await user.pointer([
      { keys: '[MouseLeft>]', target: handle('nw'), coords: { clientX: 100, clientY: 100 } },
      { coords: { clientX: 900, clientY: 900 } },
      { keys: '[/MouseLeft]' }
    ])
    expect(currentGroup()).toMatchObject({ x: 220, y: 180, w: 160, h: 120 })
  })

  it('has 8 handles; a rolled-up group keeps only the side ones', () => {
    renderGroup()
    expect(document.querySelectorAll('[data-resize-edge]')).toHaveLength(8)
    act(() => useLayoutStore.getState().toggleRollUp(1, 'g'))
    expect(
      [...document.querySelectorAll('[data-resize-edge]')].map((el) =>
        el.getAttribute('data-resize-edge')
      )
    ).toEqual(['e', 'w'])
  })

  it('a handle’s pointerdown does not reach the drag-and-drop sensor around it', () => {
    const sensor = vi.fn()
    renderGroup({}, (node) => <div onPointerDown={sensor}>{node}</div>)
    fireEvent.pointerDown(handle('e'), { button: 0, pointerId: 1, clientX: 380, clientY: 150 })
    fireEvent.pointerUp(handle('e'), { button: 0, pointerId: 1 })
    expect(sensor).not.toHaveBeenCalled()
  })

  it('moves by its title bar, clamped to the work area, and comes to the front', async () => {
    installFakeBridge()
    const { region, user } = renderGroup()
    act(() => {
      useLayoutStore.getState().addGroup(1, makeGroup('other', { z: 9 }))
    })
    const title = within(region).getByRole('heading', { name: 'Work' })
    await user.pointer([
      { keys: '[MouseLeft>]', target: title, coords: { clientX: 150, clientY: 110 } },
      { coords: { clientX: 100, clientY: 60 } },
      { coords: { clientX: 0, clientY: 0 } },
      { keys: '[/MouseLeft]' }
    ])
    // −150, −110 from (100, 100): clamped at the work area's top-left corner.
    expect(currentGroup()).toMatchObject({ x: 0, y: 0 })
    expect(currentGroup().z).toBeGreaterThan(9)
  })

  it('renames inline when asked (new group), committing on Enter', async () => {
    const { region, user } = renderGroup()
    act(() => useUiStore.getState().startRename({ kind: 'group', id: 'g' }))
    const input = within(region).getByRole('textbox', { name: 'Rename group Work' })
    expect(input).toHaveFocus()
    await user.keyboard('Inbox: today{Enter}')
    expect(currentGroup().title).toBe('Inbox: today')
    expect(useUiStore.getState().renaming).toBeNull()
  })

  it('Rename from the menu (or the … button) opens a focused rename field', async () => {
    const { region, user } = renderGroup()
    await user.click(within(region).getByRole('button', { name: 'Group options' }))
    await user.click(await screen.findByRole('menuitem', { name: /Rename/ }))
    await waitFor(() =>
      expect(within(region).getByRole('textbox', { name: 'Rename group Work' })).toHaveFocus()
    )
    await user.keyboard('Later{Enter}')
    expect(currentGroup().title).toBe('Later')
  })

  it('F2 on the title bar renames the group', async () => {
    const { region, user } = renderGroup()
    within(region).getByRole('button', { name: 'Roll up' }).focus()
    await user.keyboard('{F2}')
    expect(within(region).getByRole('textbox', { name: 'Rename group Work' })).toHaveFocus()
  })

  it('offers its actions in a context menu; Delete asks first and never deletes files', async () => {
    const bridge = installFakeBridge()
    const { region, user } = renderGroup()
    fireEvent.contextMenu(within(region).getByRole('heading', { name: 'Work' }))
    const menu = await screen.findByRole('menu')
    expect(
      [...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent)
    ).toEqual([
      'RenameF2',
      'Roll up',
      'Sort by',
      'Icon size',
      'Exclude from quick-hide',
      'Move to display',
      'Delete group'
    ])

    await user.click(within(menu).getByRole('menuitem', { name: 'Delete group' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete group “Work”?' })
    expect(dialog).toHaveTextContent('Its 3 items go back to the desktop. No files are deleted.')
    await user.click(within(dialog).getByRole('button', { name: 'Delete group' }))

    const display = useLayoutStore.getState().layout.displays[0]
    expect(display.groups).toEqual([])
    expect(Object.keys(display.loose).sort()).toEqual(['1:1', '1:2', '1:3'])
    expect(bridge.desktop.trash).not.toHaveBeenCalled()
  })

  it('Move to display lists the other displays and clamps the group into the chosen one', async () => {
    const bridge = installFakeBridge()
    const second = {
      id: 2,
      bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
      workArea: { x: 2560, y: 0, width: 1920, height: 1032 },
      scaleFactor: 1
    }
    const { region, user } = renderGroup({ x: 2200, y: 1100, w: 300, h: 200 })
    bridge.display.list.mockResolvedValue([PRIMARY_INFO, second])
    act(() => useLayoutStore.getState().ensureDisplay({ id: 2, bounds: second.bounds }))

    fireEvent.contextMenu(within(region).getByRole('heading', { name: 'Work' }))
    // Submenus by keyboard (jsdom has no layout for Radix's pointer grace area).
    ;(await screen.findByRole('menuitem', { name: 'Move to display' })).focus()
    await user.keyboard('{ArrowRight}')
    const target = await screen.findByRole('menuitem', { name: 'Display 2 (1920 × 1080)' })
    await waitFor(() => expect(target).toHaveFocus())
    await user.keyboard('{Enter}')

    const displays = useLayoutStore.getState().layout.displays
    expect(displays[0].groups).toEqual([])
    expect(displays[1].groups[0]).toMatchObject({ id: 'g', x: 1620, y: 832, w: 300, h: 200 })
  })

  it('has no detectable accessibility violations', async () => {
    renderGroup()
    expect(await axe(document.body)).toHaveNoViolations()
  })
})
