import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ShellMenuShowResult } from '@shared/ipc'
import { ITEM_MENU_IDS } from '@shared/shell-menu'
import { useLayoutStore } from '../../stores/layout'
import { useUiStore } from '../../stores/ui'
import { desktopItem, makeGroup, PRIMARY_INFO, seedCanvas } from '../../test/canvas-fixtures'
import { installFakeBridge, type FakeBridge } from '../../test/fake-bridge'
import { DesktopCanvas } from '../canvas/DesktopCanvas'
import { ConfirmHost } from '../feedback/ConfirmDialog'
import { Toaster } from '../feedback/Toaster'

// Native menus, Phase 4: with native menus on, a right-click on icons asks main for Windows'
// file menu of those files; Taskyard's own (Radix) icon menu opens only when that fails.

const NOTES = desktopItem('1:1', 'Notes')
const TOOL = desktopItem('1:2', 'Tool', { kind: 'link', ext: '.lnk' })
const SHARED = desktopItem('1:4', 'Shared', {
  readonly: true,
  path: 'C:/Users/Public/Desktop/Shared.txt'
})
const PLAN = desktopItem('1:5', 'Plan')
const CLOUD = desktopItem('1:6', 'Cloud', { placeholder: true })
const GROUP = makeGroup('g', { title: 'Work', x: 600, y: 300, w: 280, h: 200, items: ['1:5'] })

function setup(
  result: ShellMenuShowResult,
  { nativeMenus = true }: { nativeMenus?: boolean } = {}
): { bridge: FakeBridge; user: ReturnType<typeof userEvent.setup> } {
  const bridge = installFakeBridge()
  bridge.shellMenu.show.mockResolvedValue(result)
  seedCanvas({
    items: [NOTES, TOOL, SHARED, PLAN, CLOUD],
    loose: {
      '1:1': { x: 0, y: 0 },
      '1:2': { x: 0, y: 96 },
      '1:4': { x: 0, y: 288 },
      '1:6': { x: 0, y: 384 }
    },
    groups: [GROUP]
  })
  useUiStore.getState().setNativeMenus(nativeMenus)
  render(
    <main>
      <DesktopCanvas displayId={PRIMARY_INFO.id} info={PRIMARY_INFO} />
      <ConfirmHost />
      <Toaster />
    </main>
  )
  return { bridge, user: userEvent.setup() }
}

const option = (name: string): HTMLElement => screen.getByRole('option', { name })

function rightClick(name: string, init: MouseEventInit = {}): void {
  fireEvent.contextMenu(option(name), { clientX: 20, clientY: 30, ...init })
}

describe('the native file menu on desktop icons', () => {
  it('selects an unselected icon first and asks main for its file menu by id; no Taskyard menu', async () => {
    const { bridge } = setup({ kind: 'dismissed' })
    act(() => useUiStore.getState().select(['1:2']))
    rightClick('Notes')
    expect(useUiStore.getState().selection).toEqual(['1:1'])
    await waitFor(() => expect(bridge.shellMenu.show).toHaveBeenCalledOnce())
    expect(bridge.shellMenu.show).toHaveBeenCalledWith({
      kind: 'items',
      displayId: PRIMARY_INFO.id,
      point: { x: 20, y: 30 },
      extendedVerbs: false,
      ids: ['1:1'],
      state: { inGroup: false, canRename: true }
    })
    await act(async () => {})
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Shift+right-click asks for Windows’ extended verbs', async () => {
    const { bridge } = setup({ kind: 'dismissed' })
    rightClick('Notes', { shiftKey: true })
    await waitFor(() =>
      expect(bridge.shellMenu.show).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'items', extendedVerbs: true })
      )
    )
  })

  it('Shift+F10 on the focused icon opens the native menu below it (keyboard route)', async () => {
    const { bridge, user } = setup({ kind: 'dismissed' })
    act(() => useUiStore.getState().select(['1:1']))
    option('Notes').focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    await waitFor(() => expect(bridge.shellMenu.show).toHaveBeenCalledOnce())
    expect(bridge.shellMenu.show.mock.calls[0][0]).toEqual(
      expect.objectContaining({ kind: 'items', ids: ['1:1'], extendedVerbs: false })
    )
  })

  it('a selection in one folder: the menu is for all of it, right-clicked first, no Rename', async () => {
    const { bridge } = setup({ kind: 'dismissed' })
    act(() => useUiStore.getState().select(['1:1', '1:2']))
    rightClick('Tool')
    await waitFor(() =>
      expect(bridge.shellMenu.show).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: ['1:2', '1:1'],
          state: { inGroup: false, canRename: false }
        })
      )
    )
    expect(useUiStore.getState().selection).toEqual(['1:1', '1:2'])
  })

  it('a selection across the user and Public Desktop: the right-clicked icon alone', async () => {
    const { bridge } = setup({ kind: 'dismissed' })
    act(() => useUiStore.getState().select(['1:1', '1:4']))
    rightClick('Notes')
    await waitFor(() =>
      expect(bridge.shellMenu.show).toHaveBeenCalledWith(
        expect.objectContaining({ ids: ['1:1'], state: { inGroup: false, canRename: true } })
      )
    )
  })

  it('read-only and online-only items get the native menu too; Taskyard never opens them itself', async () => {
    const { bridge } = setup({ kind: 'invoked', verb: 'open', label: 'Open', path: [] })
    rightClick('Shared')
    await waitFor(() =>
      expect(bridge.shellMenu.show).toHaveBeenLastCalledWith(
        expect.objectContaining({ ids: ['1:4'], state: { inGroup: false, canRename: false } })
      )
    )
    rightClick('Cloud')
    await waitFor(() =>
      expect(bridge.shellMenu.show).toHaveBeenLastCalledWith(
        expect.objectContaining({ ids: ['1:6'], state: { inGroup: false, canRename: true } })
      )
    )
    await act(async () => {})
    // Windows ran Open: Taskyard did not open anything, and no Taskyard menu opened.
    expect(bridge.desktop.open).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Windows’ Rename opens Taskyard’s inline rename on the right-clicked icon', async () => {
    const { bridge, user } = setup({
      kind: 'intercepted',
      verb: 'rename',
      label: 'Rename',
      path: []
    })
    rightClick('Notes')
    const input = await screen.findByRole('textbox', { name: 'Rename Notes' })
    await waitFor(() => expect(input).toHaveFocus())
    await user.keyboard('Journal{Enter}')
    expect(bridge.desktop.rename).toHaveBeenCalledExactlyOnceWith('1:1', 'Journal.txt')
  })

  it('never renames a read-only item, even if Windows answered Rename', async () => {
    setup({ kind: 'intercepted', verb: 'rename', label: 'Rename', path: [] })
    rightClick('Shared')
    await act(async () => {})
    expect(useUiStore.getState().renaming).toBeNull()
  })

  it('in a group: the icon’s menu (not the group’s), and Remove from group makes it loose', async () => {
    const { bridge } = setup({ kind: 'taskyard', id: ITEM_MENU_IDS.removeFromGroup })
    rightClick('Plan')
    await waitFor(() =>
      expect(useLayoutStore.getState().layout.displays[0].loose['1:5']).toBeDefined()
    )
    expect(bridge.shellMenu.show).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ids: ['1:5'], state: { inGroup: true, canRename: true } })
    )
    expect(useLayoutStore.getState().layout.displays[0].groups[0].items).toEqual([])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Taskyard’s Copy path copies the targets’ paths', async () => {
    setup({ kind: 'taskyard', id: ITEM_MENU_IDS.copyPath })
    rightClick('Tool')
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe('C:\\Users\\me\\Desktop\\Tool.lnk')
    )
    expect(await screen.findByText('Path copied')).toBeInTheDocument()
  })

  it('a failed Windows command shows a toast, never Taskyard’s menu', async () => {
    setup({
      kind: 'invoke-failed',
      verb: 'delete',
      label: 'Delete',
      path: [],
      message: 'The file is in use.'
    })
    rightClick('Notes')
    expect(await screen.findByText('Windows couldn’t complete “Delete”.')).toBeInTheDocument()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('falls back to Taskyard’s icon menu at the same point when the native menu cannot show', async () => {
    const { bridge, user } = setup({ kind: 'fallback', reason: 'timeout' })
    rightClick('Notes')
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Open' })).toBeInTheDocument()
    await user.click(within(menu).getByRole('menuitem', { name: 'Open' }))
    expect(bridge.desktop.open).toHaveBeenCalledExactlyOnceWith('1:1')
  })

  it('keeps Taskyard’s icon menu (at once, no round trip) while native menus are off', async () => {
    const { bridge } = setup({ kind: 'dismissed' }, { nativeMenus: false })
    rightClick('Notes')
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(bridge.shellMenu.show).not.toHaveBeenCalled()
  })
})
