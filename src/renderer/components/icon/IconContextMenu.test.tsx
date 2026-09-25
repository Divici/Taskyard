import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { rectsIntersect } from '@shared/geometry'
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
import { DesktopCanvas } from '../canvas/DesktopCanvas'
import { ConfirmHost } from '../feedback/ConfirmDialog'
import { Toaster } from '../feedback/Toaster'

const NOTES = desktopItem('1:1', 'Notes')
const TOOL = desktopItem('1:2', 'Tool', { kind: 'link', ext: '.lnk' })
const SITE = desktopItem('1:3', 'Docs', { kind: 'url', ext: '.url', url: 'https://example.com/' })
const LOCKED = desktopItem('1:4', 'Shared', {
  readonly: true,
  path: 'C:\\Users\\Public\\Desktop\\Shared.txt'
})
const PLAN = desktopItem('1:5', 'Plan')
const ITEMS = [NOTES, TOOL, SITE, LOCKED, PLAN]

const GROUP = makeGroup('g', { title: 'Work', x: 600, y: 300, w: 280, h: 200, items: ['1:5'] })

function setup(seed: SeedOptions = {}): {
  bridge: FakeBridge
  user: ReturnType<typeof userEvent.setup>
} {
  const bridge = installFakeBridge()
  seedCanvas({
    items: ITEMS,
    loose: {
      '1:1': { x: 0, y: 0 },
      '1:2': { x: 0, y: 96 },
      '1:3': { x: 0, y: 192 },
      '1:4': { x: 0, y: 288 }
    },
    groups: [GROUP],
    ...seed
  })
  render(
    <main>
      <DesktopCanvas displayId={1} info={PRIMARY_INFO} />
      <ConfirmHost />
      <Toaster />
    </main>
  )
  return { bridge, user: userEvent.setup() }
}

const option = (name: string): HTMLElement => screen.getByRole('option', { name })

async function openMenu(name: string): Promise<HTMLElement> {
  fireEvent.contextMenu(option(name), { clientX: 20, clientY: 20 })
  return screen.findByRole('menu')
}

const menuItem = (menu: HTMLElement, name: string | RegExp): HTMLElement =>
  within(menu).getByRole('menuitem', { name })

describe('IconContextMenu', () => {
  it('offers the item actions (no "Remove from group" for a loose icon)', async () => {
    setup()
    const menu = await openMenu('Notes')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent)
    ).toEqual(['Open', 'Open file location', 'RenameF2', 'Copy pathCtrl+Shift+C', 'DeleteDel'])
  })

  it('right-clicking an unselected icon selects it (and only it)', async () => {
    setup()
    act(() => useUiStore.getState().select(['1:2']))
    await openMenu('Notes')
    expect(useUiStore.getState().selection).toEqual(['1:1'])
  })

  it('Open asks main to open the item: a .lnk, a .url and a file alike', async () => {
    const { bridge, user } = setup()
    for (const name of ['Tool', 'Docs', 'Notes']) {
      await user.click(menuItem(await openMenu(name), 'Open'))
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    }
    expect(bridge.desktop.open.mock.calls.map(([id]) => id)).toEqual(['1:2', '1:3', '1:1'])
  })

  it("Open's failure string from Windows becomes a toast", async () => {
    const { bridge, user } = setup()
    bridge.desktop.open.mockResolvedValueOnce({
      ok: false,
      code: 'failed',
      message: 'No application is associated with this file.'
    })
    await user.click(menuItem(await openMenu('Notes'), 'Open'))
    expect(await screen.findByText('“Notes.txt” couldn’t be opened.')).toBeInTheDocument()
    expect(screen.getByText('No application is associated with this file.')).toBeInTheDocument()
  })

  it('Open file location shows the item in Explorer', async () => {
    const { bridge, user } = setup()
    await user.click(menuItem(await openMenu('Tool'), 'Open file location'))
    expect(bridge.desktop.showInFolder).toHaveBeenCalledExactlyOnceWith('1:2')
  })

  it('Copy path puts the full path on the clipboard and says so', async () => {
    const { user } = setup()
    await user.click(menuItem(await openMenu('Notes'), /Copy path/))
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe('C:\\Users\\me\\Desktop\\Notes.txt')
    )
    expect(await screen.findByText('Path copied')).toBeInTheDocument()
  })

  it('Rename opens the inline rename field on the item', async () => {
    const { bridge, user } = setup()
    await user.click(menuItem(await openMenu('Notes'), /Rename/))
    const input = await screen.findByRole('textbox', { name: 'Rename Notes' })
    await waitFor(() => expect(input).toHaveFocus())
    await user.keyboard('Journal{Enter}')
    expect(bridge.desktop.rename).toHaveBeenCalledExactlyOnceWith('1:1', 'Journal.txt')
  })

  it('a rename that collides (EEXIST) reopens the field with an inline error, not a toast', async () => {
    const { bridge, user } = setup()
    bridge.desktop.rename.mockResolvedValueOnce({
      ok: false,
      code: 'exists',
      message: 'EEXIST'
    })
    await user.click(menuItem(await openMenu('Notes'), /Rename/))
    await screen.findByRole('textbox', { name: 'Rename Notes' })
    await user.keyboard('Plan{Enter}')

    const input = await screen.findByRole('textbox', { name: 'Rename Notes' })
    expect(input).toHaveValue('Plan')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('“Plan.txt” already exists.')
    expect(screen.queryByText(/can’t be renamed/)).toBeNull()

    bridge.desktop.rename.mockResolvedValueOnce({ ok: true, path: 'C:\\x\\Plan 2.txt' })
    await user.keyboard('{End} 2{Enter}')
    expect(bridge.desktop.rename).toHaveBeenLastCalledWith('1:1', 'Plan 2.txt')
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
  })

  it('a rename Windows refuses (EPERM) closes the field and shows a toast', async () => {
    const { bridge, user } = setup()
    bridge.desktop.rename.mockResolvedValueOnce({
      ok: false,
      code: 'permission',
      message: 'EPERM'
    })
    await user.click(menuItem(await openMenu('Notes'), /Rename/))
    await screen.findByRole('textbox', { name: 'Rename Notes' })
    await user.keyboard('Journal{Enter}')

    expect(
      await screen.findByText('“Notes.txt” can’t be changed: Windows denied access.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('Delete asks first (listing the names), then sends the item to the Recycle Bin', async () => {
    const { bridge, user } = setup()
    await user.click(menuItem(await openMenu('Notes'), /Delete/))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Move “Notes.txt” to the Recycle Bin?'
    })
    expect(bridge.desktop.trash).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(bridge.desktop.trash).toHaveBeenCalledExactlyOnceWith('1:1'))
  })

  it('acts on the whole selection when the right-clicked icon is part of it', async () => {
    const { bridge, user } = setup()
    act(() => useUiStore.getState().select(['1:1', '1:2', '1:3']))
    const menu = await openMenu('Tool')
    expect(useUiStore.getState().selection).toEqual(['1:1', '1:2', '1:3'])
    // One name to rename: disabled for several items.
    expect(menuItem(menu, /Rename/)).toHaveAttribute('aria-disabled', 'true')
    await user.click(menuItem(menu, 'Open'))
    expect(bridge.desktop.open.mock.calls.map(([id]) => id)).toEqual(['1:1', '1:2', '1:3'])

    await user.click(menuItem(await openMenu('Tool'), /Delete/))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Move 3 items to the Recycle Bin?'
    })
    expect(dialog).toHaveTextContent('Notes.txt')
    expect(dialog).toHaveTextContent('Docs.url')
  })

  it('Rename and Delete are disabled for a read-only item; Open and Copy path still work', async () => {
    const { bridge, user } = setup()
    const menu = await openMenu('Shared')
    expect(menuItem(menu, /Rename/)).toHaveAttribute('aria-disabled', 'true')
    expect(menuItem(menu, /Delete/)).toHaveAttribute('aria-disabled', 'true')
    expect(menuItem(menu, 'Open')).not.toHaveAttribute('aria-disabled')

    await user.click(menuItem(menu, /Rename/))
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(menuItem(await openMenu('Shared'), /Copy path/))
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe('C:\\Users\\Public\\Desktop\\Shared.txt')
    )
    expect(bridge.desktop.rename).not.toHaveBeenCalled()
  })

  describe('in a group', () => {
    it('opens the item menu, not the group menu, and offers "Remove from group"', async () => {
      setup()
      const menu = await openMenu('Plan')
      expect(screen.getAllByRole('menu')).toHaveLength(1)
      expect(menuItem(menu, 'Remove from group')).toBeInTheDocument()
      expect(within(menu).queryByRole('menuitem', { name: 'Roll up' })).toBeNull()
    })

    it('"Remove from group" makes the item loose, in a free cell outside every group', async () => {
      const { user } = setup()
      await user.click(menuItem(await openMenu('Plan'), 'Remove from group'))

      const display = useLayoutStore.getState().layout.displays[0]
      expect(display.groups[0].items).toEqual([])
      const point = display.loose['1:5']
      expect(point).toBeDefined()
      const cell = { ...point, width: 96, height: 96 }
      const group = { x: GROUP.x, y: GROUP.y, width: GROUP.w, height: GROUP.h }
      expect(rectsIntersect(cell, group)).toBe(false)
      for (const [id, other] of Object.entries(display.loose)) {
        if (id !== '1:5')
          expect(rectsIntersect(cell, { ...other, width: 96, height: 96 })).toBe(false)
      }
      expect(
        within(screen.getByRole('listbox', { name: 'Desktop icons' })).getByRole('option', {
          name: 'Plan'
        })
      ).toBeInTheDocument()
    })

    it('"Remove from group" takes only the selected items of this group', async () => {
      const { user } = setup({
        groups: [{ ...GROUP, items: ['1:5', '1:1'] }],
        loose: { '1:2': { x: 0, y: 0 } }
      })
      act(() => useUiStore.getState().select(['1:5', '1:1', '1:2']))
      await user.click(menuItem(await openMenu('Plan'), 'Remove from group'))
      const display = useLayoutStore.getState().layout.displays[0]
      expect(display.groups[0].items).toEqual([])
      expect(Object.keys(display.loose).sort()).toEqual(['1:1', '1:2', '1:5'])
      expect(display.loose['1:2']).toEqual({ x: 0, y: 0 })
    })
  })
})
