import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ITEM_MENU_IDS } from '@shared/shell-menu'
import { useUiStore } from '../stores/ui'
import { desktopItem, seedCanvas } from '../test/canvas-fixtures'
import { installFakeBridge, type FakeBridge } from '../test/fake-bridge'
import {
  itemMenuTargetsFor,
  routeItemMenuResult,
  showItemShellMenu,
  type ItemMenuActions
} from './item-shell-menu'

// Native menus, Phase 4: a right-click on icons shows Windows' file menu for them.

function actions(): { [K in keyof ItemMenuActions]: ReturnType<typeof vi.fn> } {
  return { removeFromGroup: vi.fn(), copyPath: vi.fn(), rename: vi.fn() }
}

const AT = { x: 40, y: 70 }
const NOTES = desktopItem('1:1', 'Notes')
const PLAN = desktopItem('1:2', 'Plan')
const SHARED = desktopItem('1:3', 'Shared', {
  readonly: true,
  path: 'C:/Users/Public/Desktop/Shared.txt'
})

describe('itemMenuTargetsFor (Explorer’s selection rules for a right-click on an icon)', () => {
  beforeEach(() => {
    installFakeBridge()
    seedCanvas({ items: [NOTES, PLAN, SHARED] })
  })

  it('selects an unselected icon first, and the menu is for it alone', () => {
    useUiStore.getState().select(['1:2'])
    expect(itemMenuTargetsFor(NOTES)).toEqual(['1:1'])
    expect(useUiStore.getState().selection).toEqual(['1:1'])
  })

  it('a selected icon: the whole selection (one folder), the right-clicked icon first', () => {
    useUiStore.getState().select(['1:1', '1:2'])
    expect(itemMenuTargetsFor(PLAN)).toEqual(['1:2', '1:1'])
    expect(useUiStore.getState().selection).toEqual(['1:1', '1:2'])
  })

  it('a selection across the user and Public Desktop: the right-clicked icon alone, selection kept', () => {
    useUiStore.getState().select(['1:1', '1:3'])
    expect(itemMenuTargetsFor(SHARED)).toEqual(['1:3'])
    expect(useUiStore.getState().selection).toEqual(['1:1', '1:3'])
  })
})

describe('routeItemMenuResult (what a choice in an icon’s native menu does)', () => {
  beforeEach(() => {
    installFakeBridge()
  })

  it('runs Taskyard’s items and Windows’ intercepted Rename', () => {
    const cases: [Parameters<typeof routeItemMenuResult>[0], keyof ItemMenuActions][] = [
      [{ kind: 'taskyard', id: ITEM_MENU_IDS.removeFromGroup }, 'removeFromGroup'],
      [{ kind: 'taskyard', id: ITEM_MENU_IDS.copyPath }, 'copyPath'],
      [{ kind: 'intercepted', verb: 'rename', label: 'Rename', path: [] }, 'rename']
    ]
    for (const [result, action] of cases) {
      const run = actions()
      routeItemMenuResult(result, run)
      expect(run[action]).toHaveBeenCalledExactlyOnceWith()
      for (const [name, mock] of Object.entries(run)) {
        if (name !== action) expect(mock).not.toHaveBeenCalled()
      }
    }
  })

  it('does nothing for dismissed, superseded, invoked (Windows ran it) and unknown results', () => {
    const run = actions()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const result of [
      { kind: 'dismissed' },
      { kind: 'superseded' },
      { kind: 'invoked', verb: 'delete', label: 'Delete', path: [] },
      { kind: 'intercepted', verb: 'refresh', label: 'Refresh', path: [] },
      { kind: 'taskyard', id: 'taskyard.quit' }
    ] as Parameters<typeof routeItemMenuResult>[0][]) {
      routeItemMenuResult(result, run)
    }
    for (const mock of Object.values(run)) expect(mock).not.toHaveBeenCalled()
    expect(useUiStore.getState().toasts).toEqual([])
    expect(warn).toHaveBeenCalledWith('shell-menu: no action for the icon menu id "taskyard.quit"')
  })

  it('tells the user when Windows could not run the chosen item', () => {
    routeItemMenuResult(
      {
        kind: 'invoke-failed',
        verb: 'delete',
        label: 'Delete',
        path: [],
        message: 'The file is in use.'
      },
      actions()
    )
    expect(useUiStore.getState().toasts).toEqual([
      expect.objectContaining({
        tone: 'error',
        message: 'Windows couldn’t complete “Delete”.',
        description: 'The file is in use.'
      })
    ])
  })
})

describe('showItemShellMenu', () => {
  let bridge: FakeBridge
  beforeEach(() => {
    bridge = installFakeBridge()
  })

  const request = {
    displayId: 1,
    point: AT,
    shiftKey: true,
    ids: ['1:2', '1:1'],
    state: { inGroup: true, canRename: false }
  }

  it('asks main for the items’ file menu by id (never by path) and routes the choice', async () => {
    bridge.shellMenu.show.mockResolvedValue({
      kind: 'taskyard',
      id: ITEM_MENU_IDS.removeFromGroup
    })
    const run = actions()
    await expect(showItemShellMenu(request, run)).resolves.toBe(true)
    expect(bridge.shellMenu.show).toHaveBeenCalledExactlyOnceWith({
      kind: 'items',
      displayId: 1,
      point: AT,
      extendedVerbs: true,
      ids: ['1:2', '1:1'],
      state: { inGroup: true, canRename: false }
    })
    expect(run.removeFromGroup).toHaveBeenCalledOnce()
  })

  it('answers false (Taskyard’s own icon menu opens) on fallback, or when main cannot be asked', async () => {
    bridge.shellMenu.show.mockResolvedValue({ kind: 'fallback', reason: 'helper-exited' })
    await expect(showItemShellMenu(request, actions())).resolves.toBe(false)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    bridge.shellMenu.show.mockRejectedValue(new Error('invalid arguments for shellMenu:show'))
    await expect(showItemShellMenu(request, actions())).resolves.toBe(false)
    expect(error).toHaveBeenCalledWith('shell-menu: asking main failed', expect.any(Error))
  })
})
