import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopChange, ShellMenuShowResult } from '@shared/ipc'
import { CANVAS_MENU_IDS } from '@shared/shell-menu'
import { useItemsStore } from '../stores/items'
import { useLayoutStore } from '../stores/layout'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { desktopItem, PRIMARY_INFO, seedCanvas } from '../test/canvas-fixtures'
import { installFakeBridge, type FakeBridge } from '../test/fake-bridge'
import {
  canvasMenuState,
  connectShellMenu,
  routeCanvasMenuResult,
  showCanvasShellMenu,
  type CanvasMenuActions
} from './shell-menu'

function actions(): { [K in keyof CanvasMenuActions]: ReturnType<typeof vi.fn> } {
  return {
    newGroup: vi.fn(),
    autoOrganize: vi.fn(),
    sortLoose: vi.fn(),
    toggleTools: vi.fn(),
    refresh: vi.fn(),
    openSettings: vi.fn(),
    quit: vi.fn(),
    setIconSize: vi.fn(),
    toggleGridSnap: vi.fn(),
    toggleQuickHide: vi.fn()
  }
}

const AT = { x: 640, y: 360 }

describe('routeCanvasMenuResult (what a native menu choice does)', () => {
  it('runs each Taskyard ▸ item', () => {
    const cases: [string, keyof CanvasMenuActions, unknown[]][] = [
      [CANVAS_MENU_IDS.newGroup, 'newGroup', [AT]],
      [CANVAS_MENU_IDS.autoOrganize, 'autoOrganize', []],
      [CANVAS_MENU_IDS.sortLoose, 'sortLoose', ['name']],
      [CANVAS_MENU_IDS.toggleTools, 'toggleTools', []],
      [CANVAS_MENU_IDS.refresh, 'refresh', []],
      [CANVAS_MENU_IDS.settings, 'openSettings', []],
      [CANVAS_MENU_IDS.quit, 'quit', []]
    ]
    for (const [id, action, args] of cases) {
      const run = actions()
      routeCanvasMenuResult({ kind: 'taskyard', id }, AT, run)
      expect(run[action]).toHaveBeenCalledExactlyOnceWith(...args)
      const others = Object.entries(run).filter(([name]) => name !== action)
      for (const [, mock] of others) expect(mock).not.toHaveBeenCalled()
    }
  })

  it('maps the replaced View ▸ and Sort by ▸ items to Taskyard settings and sorts', () => {
    const cases: [string, keyof CanvasMenuActions, unknown[]][] = [
      [CANVAS_MENU_IDS.iconLarge, 'setIconSize', ['large']],
      [CANVAS_MENU_IDS.iconMedium, 'setIconSize', ['medium']],
      [CANVAS_MENU_IDS.iconSmall, 'setIconSize', ['small']],
      [CANVAS_MENU_IDS.gridSnap, 'toggleGridSnap', []],
      [CANVAS_MENU_IDS.showIcons, 'toggleQuickHide', []],
      [CANVAS_MENU_IDS.sortName, 'sortLoose', ['name']],
      [CANVAS_MENU_IDS.sortSize, 'sortLoose', ['size']],
      [CANVAS_MENU_IDS.sortType, 'sortLoose', ['type']],
      [CANVAS_MENU_IDS.sortDate, 'sortLoose', ['modified']]
    ]
    for (const [id, action, args] of cases) {
      const run = actions()
      routeCanvasMenuResult({ kind: 'taskyard', id }, AT, run)
      expect(run[action]).toHaveBeenCalledExactlyOnceWith(...args)
    }
  })

  it('maps Windows’ intercepted Refresh to a rescan', () => {
    const run = actions()
    routeCanvasMenuResult(
      { kind: 'intercepted', verb: 'refresh', label: 'Refresh', path: [] },
      AT,
      run
    )
    expect(run.refresh).toHaveBeenCalledOnce()
  })

  it('does nothing for dismissed, superseded, invoked and anything unknown', () => {
    const run = actions()
    const quiet: ShellMenuShowResult[] = [
      { kind: 'dismissed' },
      { kind: 'superseded' },
      { kind: 'invoked', verb: 'Display', label: 'Display settings', path: [] },
      { kind: 'intercepted', verb: 'sortascending', label: 'Ascending', path: ['Sort by'] },
      { kind: 'taskyard', id: 'nope' }
    ]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const result of quiet) routeCanvasMenuResult(result, AT, run)
    for (const mock of Object.values(run)) expect(mock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledExactlyOnceWith('shell-menu: no action for the menu id "nope"')
  })

  it('tells the user when a chosen Windows item failed', () => {
    installFakeBridge()
    routeCanvasMenuResult(
      {
        kind: 'invoke-failed',
        verb: 'paste',
        label: 'Paste',
        path: [],
        message: 'Access is denied.'
      },
      AT,
      actions()
    )
    expect(useUiStore.getState().toasts).toEqual([
      expect.objectContaining({
        tone: 'error',
        message: 'Windows couldn’t complete “Paste”.',
        description: 'Access is denied.'
      })
    ])
  })
})

describe('showCanvasShellMenu', () => {
  let bridge: FakeBridge
  beforeEach(() => {
    bridge = installFakeBridge()
    seedCanvas({ settings: { iconSize: 'large', gridSnap: false } })
    useUiStore.getState().setQuickHidden(true)
  })

  it('asks main for the Desktop background menu with the window’s state; the renderer names no path', async () => {
    bridge.shellMenu.show.mockResolvedValue({ kind: 'dismissed' })
    await expect(
      showCanvasShellMenu({ displayId: 1, point: AT, shiftKey: true, toolsShown: true }, actions())
    ).resolves.toBe(true)
    expect(bridge.shellMenu.show).toHaveBeenCalledExactlyOnceWith({
      kind: 'background',
      displayId: 1,
      point: AT,
      extendedVerbs: true,
      state: { iconSize: 'large', gridSnap: false, quickHidden: true, toolsShown: true }
    })
  })

  it('routes the result and reports it handled', async () => {
    bridge.shellMenu.show.mockResolvedValue({ kind: 'taskyard', id: CANVAS_MENU_IDS.newGroup })
    const run = actions()
    await expect(
      showCanvasShellMenu({ displayId: 1, point: AT, shiftKey: false, toolsShown: false }, run)
    ).resolves.toBe(true)
    expect(run.newGroup).toHaveBeenCalledExactlyOnceWith(AT)
  })

  it('answers false (open Taskyard’s own menu) on fallback, or when the request itself fails', async () => {
    bridge.shellMenu.show.mockResolvedValue({ kind: 'fallback', reason: 'timeout' })
    await expect(
      showCanvasShellMenu(
        { displayId: 1, point: AT, shiftKey: false, toolsShown: false },
        actions()
      )
    ).resolves.toBe(false)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    bridge.shellMenu.show.mockRejectedValue(new Error('invalid arguments for shellMenu:show'))
    await expect(
      showCanvasShellMenu(
        { displayId: 1, point: AT, shiftKey: false, toolsShown: false },
        actions()
      )
    ).resolves.toBe(false)
    expect(error).toHaveBeenCalledWith('shell-menu: asking main failed', expect.any(Error))
  })

  it('reads the menu state from the stores', () => {
    expect(canvasMenuState(true)).toEqual({
      iconSize: 'large',
      gridSnap: false,
      quickHidden: true,
      toolsShown: true
    })
  })
})

describe('connectShellMenu', () => {
  const NEW = desktopItem('2:1', 'New folder', { kind: 'folder' })

  function change(patch: Partial<DesktopChange> = {}): DesktopChange {
    return { added: [NEW], removed: [], changed: [], ...patch }
  }

  it('turns native menus on only when main says they can show', async () => {
    const bridge = installFakeBridge()
    bridge.shellMenu.available.mockResolvedValue(true)
    const disconnect = connectShellMenu(bridge)
    await waitFor(() => expect(useUiStore.getState().nativeMenus).toBe(true))
    disconnect()
  })

  it('keeps Taskyard’s menus when main cannot be asked', async () => {
    const bridge = installFakeBridge()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    bridge.shellMenu.available.mockRejectedValue(new Error('no handler'))
    const disconnect = connectShellMenu(bridge)
    await waitFor(() => expect(error).toHaveBeenCalled())
    expect(useUiStore.getState().nativeMenus).toBe(false)
    disconnect()
  })

  it('puts a New ▸ item at the right-click cell of this display and opens its inline rename', () => {
    const bridge = installFakeBridge()
    seedCanvas({ items: [desktopItem('1:1', 'Notes')], loose: { '1:1': { x: 0, y: 0 } } })
    const disconnect = connectShellMenu(bridge)
    // The item arrives (desktop-sync) and the primary window already put it in the first free cell.
    useItemsStore.getState().applyChange(change())
    useLayoutStore.getState().placeItems(1, ['2:1'], { loose: [{ x: 0, y: 96 }] })

    bridge.emit(
      'desktop:changed',
      change({
        placeAt: { displayId: 1, point: { x: 700, y: 500 }, ids: ['2:1'], renameId: '2:1' }
      })
    )

    // The medium cell is 96 × 96: the cell whose centre is nearest (700, 500) starts at (672, 480).
    expect(useLayoutStore.getState().layout.displays[0].loose['2:1']).toEqual({ x: 672, y: 480 })
    expect(useUiStore.getState().renaming).toEqual({ kind: 'item', id: '2:1' })
    disconnect()
  })

  it('places pasted items from the point without renaming', () => {
    const bridge = installFakeBridge()
    seedCanvas({ items: [] })
    const disconnect = connectShellMenu(bridge)
    const other = desktopItem('2:2', 'b')
    useItemsStore.getState().applyChange(change({ added: [NEW, other] }))
    bridge.emit(
      'desktop:changed',
      change({
        added: [NEW, other],
        placeAt: { displayId: 1, point: { x: 10, y: 10 }, ids: ['2:1', '2:2'], renameId: null }
      })
    )
    expect(useLayoutStore.getState().layout.displays[0].loose).toEqual({
      '2:1': { x: 0, y: 0 },
      '2:2': { x: 0, y: 96 }
    })
    expect(useUiStore.getState().renaming).toBeNull()
    disconnect()
  })

  it('leaves another display’s items to its own window', () => {
    const bridge = installFakeBridge()
    seedCanvas({ items: [] })
    const disconnect = connectShellMenu(bridge)
    bridge.emit(
      'desktop:changed',
      change({ placeAt: { displayId: 99, point: { x: 0, y: 0 }, ids: ['2:1'], renameId: '2:1' } })
    )
    expect(useLayoutStore.getState().layout.displays[0].loose).toEqual({})
    expect(useUiStore.getState().renaming).toBeNull()
    disconnect()
    expect(bridge.listenerCount('desktop:changed')).toBe(0)
  })

  it('uses the icon size the settings say', () => {
    const bridge = installFakeBridge()
    seedCanvas({ items: [], settings: { iconSize: 'small' } })
    expect(useSettingsStore.getState().settings.iconSize).toBe('small')
    const disconnect = connectShellMenu(bridge)
    bridge.emit(
      'desktop:changed',
      change({
        placeAt: {
          displayId: PRIMARY_INFO.id,
          point: { x: 100, y: 100 },
          ids: ['2:1'],
          renameId: null
        }
      })
    )
    // The small loose cell is 80 × 80: nearest cell to (100, 100) starts at (80, 80).
    expect(useLayoutStore.getState().layout.displays[0].loose['2:1']).toEqual({ x: 80, y: 80 })
    disconnect()
  })
})
