import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ShellMenuShowResult } from '@shared/ipc'
import type { Group } from '@shared/schema'
import { CANVAS_MENU_IDS } from '@shared/shell-menu'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import { desktopItem, PRIMARY_INFO, seedCanvas } from '../../test/canvas-fixtures'
import { installFakeBridge, type FakeBridge } from '../../test/fake-bridge'
import { ConfirmHost } from '../feedback/ConfirmDialog'
import { Toaster } from '../feedback/Toaster'
import { DesktopCanvas } from './DesktopCanvas'

// Native menus, Phase 3: with native menus on, the empty desktop's right-click asks main for the
// real Windows menu; Taskyard's own (Radix) menu opens only when that fails.

function renderCanvas(
  result: ShellMenuShowResult,
  { nativeMenus = true }: { nativeMenus?: boolean } = {}
): { bridge: FakeBridge; user: ReturnType<typeof userEvent.setup> } {
  const bridge = installFakeBridge()
  bridge.shellMenu.show.mockResolvedValue(result)
  seedCanvas({ items: [desktopItem('1:1', 'Notes')], loose: { '1:1': { x: 500, y: 500 } } })
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

const surface = (): HTMLElement => document.querySelector('[data-canvas-surface]') as HTMLElement
const groups = (): Group[] => useLayoutStore.getState().layout.displays[0].groups

describe('the native desktop menu on the canvas', () => {
  it('a right-click asks main for the native menu at the click point, and no Taskyard menu opens', async () => {
    const { bridge } = renderCanvas({ kind: 'dismissed' })
    fireEvent.contextMenu(surface(), { clientX: 700, clientY: 500 })
    await waitFor(() => expect(bridge.shellMenu.show).toHaveBeenCalledOnce())
    expect(bridge.shellMenu.show).toHaveBeenCalledWith({
      kind: 'background',
      displayId: PRIMARY_INFO.id,
      point: { x: 700, y: 500 },
      extendedVerbs: false,
      state: { iconSize: 'medium', gridSnap: true, quickHidden: false, toolsShown: true }
    })
    await act(async () => {})
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('Shift+right-click asks for Windows’ extended verbs', async () => {
    const { bridge } = renderCanvas({ kind: 'dismissed' })
    fireEvent.contextMenu(surface(), { clientX: 10, clientY: 20, shiftKey: true })
    await waitFor(() =>
      expect(bridge.shellMenu.show).toHaveBeenCalledWith(
        expect.objectContaining({ extendedVerbs: true, point: { x: 10, y: 20 } })
      )
    )
  })

  it('Shift+F10 on the focused desktop opens the native menu too (keyboard route)', async () => {
    const { bridge, user } = renderCanvas({ kind: 'dismissed' })
    surface().focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    await waitFor(() => expect(bridge.shellMenu.show).toHaveBeenCalledOnce())
    // A keyboard menu is not a Shift+right-click: no extended verbs.
    expect(bridge.shellMenu.show.mock.calls[0][0].extendedVerbs).toBe(false)
  })

  it('Taskyard ▸ New group here makes the group at the click point with its rename open', async () => {
    renderCanvas({ kind: 'taskyard', id: CANVAS_MENU_IDS.newGroup })
    fireEvent.contextMenu(surface(), { clientX: 701, clientY: 499 })
    await waitFor(() =>
      expect(groups()).toEqual([
        expect.objectContaining({ title: 'New group', x: 704, y: 496, w: 280, h: 200 })
      ])
    )
    expect(useUiStore.getState().renaming).toEqual({ kind: 'group', id: groups()[0].id })
  })

  it('View ▸ Small icons sets Taskyard’s icon size; Windows’ Refresh rescans', async () => {
    const { bridge } = renderCanvas({ kind: 'taskyard', id: CANVAS_MENU_IDS.iconSmall })
    fireEvent.contextMenu(surface(), { clientX: 5, clientY: 5 })
    await waitFor(() => expect(useSettingsStore.getState().settings.iconSize).toBe('small'))

    bridge.shellMenu.show.mockResolvedValue({
      kind: 'intercepted',
      verb: 'refresh',
      label: 'Refresh',
      path: []
    })
    fireEvent.contextMenu(surface(), { clientX: 5, clientY: 5 })
    await waitFor(() => expect(bridge.desktop.rescan).toHaveBeenCalledOnce())
  })

  it('Sort by ▸ Name lays the loose icons out by name', async () => {
    renderCanvas({ kind: 'taskyard', id: CANVAS_MENU_IDS.sortName })
    fireEvent.contextMenu(surface(), { clientX: 5, clientY: 5 })
    await waitFor(() =>
      expect(useLayoutStore.getState().layout.displays[0].loose).toEqual({ '1:1': { x: 0, y: 0 } })
    )
  })

  it('a failed Windows command shows a toast, never Taskyard’s menu', async () => {
    renderCanvas({
      kind: 'invoke-failed',
      verb: 'paste',
      label: 'Paste',
      path: [],
      message: 'Access is denied.'
    })
    fireEvent.contextMenu(surface(), { clientX: 5, clientY: 5 })
    expect(await screen.findByText('Windows couldn’t complete “Paste”.')).toBeInTheDocument()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('falls back to Taskyard’s menu at the same point when the native menu cannot show', async () => {
    const { user } = renderCanvas({ kind: 'fallback', reason: 'timeout' })
    fireEvent.contextMenu(surface(), { clientX: 701, clientY: 499 })
    const menu = await screen.findByRole('menu')
    await user.click(within(menu).getByRole('menuitem', { name: 'New group here' }))
    expect(groups()).toEqual([expect.objectContaining({ x: 704, y: 496 })])
  })

  it('keeps Taskyard’s menu (at once, no round trip) while native menus are off', async () => {
    const { bridge } = renderCanvas({ kind: 'dismissed' }, { nativeMenus: false })
    fireEvent.contextMenu(surface(), { clientX: 700, clientY: 500 })
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(bridge.shellMenu.show).not.toHaveBeenCalled()
  })
})
