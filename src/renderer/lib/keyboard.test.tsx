import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Group } from '@shared/schema'
import { GroupWindow } from '../components/group/GroupWindow'
import { ConfirmHost } from '../components/feedback/ConfirmDialog'
import { useLayoutStore } from '../stores/layout'
import { useUiStore } from '../stores/ui'
import { desktopItem, makeGroup, seedCanvas } from '../test/canvas-fixtures'
import { installFakeBridge, type FakeBridge } from '../test/fake-bridge'
import { gridNeighbor, itemKeyAction, spatialNeighbor } from './keyboard'

describe('itemKeyAction', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}): ReturnType<typeof itemKeyAction> =>
    itemKeyAction({
      key: k,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...mods
    })

  it('maps the Explorer keys to actions', () => {
    expect(key('ArrowRight')).toEqual({ type: 'move', direction: 'right' })
    expect(key('ArrowUp')).toEqual({ type: 'move', direction: 'up' })
    expect(key('Enter')).toEqual({ type: 'open' })
    expect(key('F2')).toEqual({ type: 'rename' })
    expect(key('Delete')).toEqual({ type: 'trash' })
    expect(key('Escape')).toEqual({ type: 'clear' })
    expect(key('a', { ctrlKey: true })).toEqual({ type: 'selectAll' })
    expect(key('A', { ctrlKey: true })).toEqual({ type: 'selectAll' })
  })

  it('Ctrl+Shift+C copies the selected items’ paths (Explorer’s "Copy as path")', () => {
    expect(key('C', { ctrlKey: true, shiftKey: true })).toEqual({ type: 'copyPath' })
    expect(key('c', { ctrlKey: true, shiftKey: true })).toEqual({ type: 'copyPath' })
    expect(key('c', { ctrlKey: true })).toBeNull()
  })

  it('ignores other keys and modified variants it does not own', () => {
    expect(key('a')).toBeNull()
    expect(key('Tab')).toBeNull()
    expect(key('ArrowRight', { altKey: true })).toBeNull()
    expect(key('Delete', { ctrlKey: true })).toBeNull()
  })
})

describe('gridNeighbor', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

  it('moves by one sideways and by a row up and down, stopping at the edges', () => {
    expect(gridNeighbor(ids, 'a', 'right', 3)).toBe('b')
    expect(gridNeighbor(ids, 'a', 'left', 3)).toBeNull()
    expect(gridNeighbor(ids, 'b', 'down', 3)).toBe('e')
    expect(gridNeighbor(ids, 'e', 'up', 3)).toBe('b')
    expect(gridNeighbor(ids, 'a', 'up', 3)).toBeNull()
    expect(gridNeighbor(ids, 'g', 'down', 3)).toBeNull()
    // Down into a short last row lands on its last item.
    expect(gridNeighbor(ids, 'e', 'down', 3)).toBe('g')
    expect(gridNeighbor(ids, 'f', 'down', 3)).toBe('g')
  })

  it('starts at the first item when nothing is focused', () => {
    expect(gridNeighbor(ids, null, 'right', 3)).toBe('a')
    expect(gridNeighbor([], null, 'right', 3)).toBeNull()
  })
})

describe('spatialNeighbor', () => {
  const points = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 0, y: 96 },
    { id: 'c', x: 96, y: 0 },
    { id: 'd', x: 96, y: 96 },
    { id: 'far', x: 800, y: 20 }
  ]

  it('picks the nearest icon in the pressed direction (free-floating loose icons)', () => {
    expect(spatialNeighbor(points, 'a', 'down')).toBe('b')
    expect(spatialNeighbor(points, 'a', 'right')).toBe('c')
    expect(spatialNeighbor(points, 'd', 'up')).toBe('c')
    expect(spatialNeighbor(points, 'c', 'right')).toBe('far')
    expect(spatialNeighbor(points, 'a', 'left')).toBeNull()
  })
})

describe('keyboard in a group', () => {
  const items = ['one', 'two', 'three', 'four', 'five', 'six'].map((name, i) =>
    desktopItem(`1:${i + 1}`, name)
  )
  // 256 px wide = 3 columns of 80 px (8 px padding each side).
  const group: Group = makeGroup('g', { w: 256, h: 300, items: items.map((i) => i.id) })

  function setup(): { bridge: FakeBridge; user: ReturnType<typeof userEvent.setup> } {
    const bridge = installFakeBridge()
    seedCanvas({
      items: [...items, desktopItem('1:9', 'readonly', { readonly: true })],
      groups: [group]
    })
    function Live(): React.JSX.Element {
      const g = useLayoutStore((state) => state.layout.displays[0].groups[0])
      return (
        <GroupWindow group={g} displayId={1} area={{ x: 0, y: 0, width: 2560, height: 1392 }} />
      )
    }
    render(
      <main>
        <Live />
        <ConfirmHost />
      </main>
    )
    return { bridge, user: userEvent.setup() }
  }

  const option = (name: string): HTMLElement => screen.getByRole('option', { name })
  const selection = (): string[] => useUiStore.getState().selection

  it('arrows move the selection and the focus through the grid, with a visible focus ring', async () => {
    const { user } = setup()
    await user.click(option('one'))
    expect(selection()).toEqual(['1:1'])

    await user.keyboard('{ArrowRight}')
    expect(selection()).toEqual(['1:2'])
    expect(option('two')).toHaveFocus()
    expect(option('two')).toHaveClass('focus-visible:ring-2')

    await user.keyboard('{ArrowDown}')
    expect(selection()).toEqual(['1:5'])
    expect(option('five')).toHaveFocus()
    expect(option('five')).toHaveAttribute('tabindex', '0')
    expect(option('two')).toHaveAttribute('tabindex', '-1')
  })

  it('Tab into the group focuses one item (roving focus)', async () => {
    const { user } = setup()
    await user.tab()
    // The header's buttons come first, then the list's single tab stop.
    while (!document.activeElement?.matches('[role="option"]')) await user.tab()
    expect(option('one')).toHaveFocus()
  })

  it('Enter opens every selected item', async () => {
    const { bridge, user } = setup()
    await user.click(option('one'))
    await user.keyboard('{Shift>}')
    await user.click(option('three'))
    await user.keyboard('{/Shift}{Enter}')
    expect(bridge.desktop.open.mock.calls.map(([id]) => id)).toEqual(['1:1', '1:2', '1:3'])
  })

  it('F2 renames the focused item in place and renames the file through main', async () => {
    const { bridge, user } = setup()
    bridge.desktop.rename.mockResolvedValue({ ok: true, path: 'C:\\Users\\me\\Desktop\\uno.txt' })
    await user.click(option('one'))
    await user.keyboard('{F2}')
    const input = screen.getByRole('textbox', { name: 'Rename one' })
    expect(input).toHaveFocus()
    await user.keyboard('uno{Enter}')
    // Extensions hidden: the typed name keeps the file's extension.
    expect(bridge.desktop.rename).toHaveBeenCalledExactlyOnceWith('1:1', 'uno.txt')
    await waitFor(() => expect(option('one')).toHaveFocus())
  })

  it('Delete asks first, then moves the selected items to the Recycle Bin', async () => {
    const { bridge, user } = setup()
    await user.click(option('one'))
    await user.keyboard('{Control>}')
    await user.click(option('two'))
    await user.keyboard('{/Control}{Delete}')

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Move 2 items to the Recycle Bin?'
    })
    expect(dialog).toHaveTextContent('one.txt')
    expect(dialog).toHaveTextContent('two.txt')
    expect(bridge.desktop.trash).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(bridge.desktop.trash.mock.calls.map(([id]) => id)).toEqual(['1:1', '1:2'])
    )
  })

  it('Delete that is cancelled trashes nothing', async () => {
    const { bridge, user } = setup()
    await user.click(option('one'))
    await user.keyboard('{Delete}')
    await screen.findByRole('alertdialog')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(bridge.desktop.trash).not.toHaveBeenCalled()
  })

  it('Esc clears the selection and Ctrl+A selects everything in the focused group', async () => {
    const { user } = setup()
    await user.click(option('three'))
    await user.keyboard('{Control>}a{/Control}')
    expect(selection()).toEqual(['1:1', '1:2', '1:3', '1:4', '1:5', '1:6'])
    await user.keyboard('{Escape}')
    expect(selection()).toEqual([])
  })

  it('Ctrl+Shift+C copies the selected paths, one per line', async () => {
    const { user } = setup()
    await user.click(option('one'))
    await user.keyboard('{Shift>}')
    await user.click(option('two'))
    await user.keyboard('{/Shift}{Control>}{Shift>}C{/Shift}{/Control}')
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        'C:\\Users\\me\\Desktop\\one.txt\r\nC:\\Users\\me\\Desktop\\two.txt'
      )
    )
  })

  it('the context-menu key (Shift+F10) opens the item menu on the focused item', async () => {
    const { user } = setup()
    await user.click(option('two'))
    await user.keyboard('{Shift>}{F10}{/Shift}')
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: /^Open$/ })).toBeInTheDocument()
  })

  it('F2 does nothing on a read-only item', async () => {
    const { user } = setup()
    act(() => useLayoutStore.getState().moveItems(1, ['1:9'], { groupId: 'g' }))
    await user.click(option('readonly'))
    await user.keyboard('{F2}')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(useUiStore.getState().renaming).toBeNull()
  })
})
