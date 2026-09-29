import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { SHELL_MENU_IPC, type ShellMenuShowRequest } from '@shared/ipc'
import { backgroundMenuPolicy, itemMenuPolicy } from '@shared/shell-menu'
import { FakeIpcMain, TRUSTED_RENDERER_URL } from '../ipc/fake-ipc-main'
import type { ShowMenuOutcome, ShowMenuRequest } from '../win32/shell-menu-api'
import {
  createCanvasMenuService,
  registerShellMenuIpc,
  type CanvasMenuService,
  type CanvasMenuServiceDeps
} from './canvas-menu'
import { ShellMenuError } from './host'

const REQUEST: ShellMenuShowRequest = {
  kind: 'background',
  displayId: 7,
  point: { x: 100.5, y: 40 },
  extendedVerbs: false,
  state: { iconSize: 'medium', gridSnap: true, quickHidden: false, toolsShown: true }
}

/** Main's desktop model in these tests (forward slashes: any path string is passed through). */
const ITEM_PATHS: Record<string, string> = {
  '1:1': 'C:/Users/me/Desktop/a.txt',
  '1:2': 'C:/Users/me/Desktop/b.txt'
}

const ITEMS_REQUEST: ShellMenuShowRequest = {
  kind: 'items',
  displayId: 7,
  point: { x: 100.5, y: 40 },
  extendedVerbs: false,
  ids: ['1:2', '1:1'],
  state: { inGroup: true, canRename: false }
}

interface StubHost {
  show: Mock<(request: ShowMenuRequest | (() => ShowMenuRequest)) => Promise<ShowMenuOutcome>>
  /** The requests as the helper would receive them (builders called when "taken"). */
  built: ShowMenuRequest[]
  cancelShows: Mock<() => void>
  helper: { pid: number } | null
}

interface Setup {
  service: CanvasMenuService
  host: StubHost
  deps: CanvasMenuServiceDeps
  holdForMenu: Mock<() => () => void>
  released: Mock<() => void>
  expectNew: Mock
  log: { warn: Mock }
  order: string[]
}

function setup(outcome: ShowMenuOutcome | Error = { kind: 'dismissed' }): Setup {
  const order: string[] = []
  const built: ShowMenuRequest[] = []
  const host: StubHost = {
    built,
    show: vi.fn(async (request: ShowMenuRequest | (() => ShowMenuRequest)) => {
      order.push('show')
      // Like the host: a builder runs when the helper takes the request, and may throw.
      built.push(typeof request === 'function' ? request() : request)
      if (outcome instanceof Error) throw outcome
      return outcome
    }),
    cancelShows: vi.fn(() => {
      order.push('cancel')
    }),
    helper: { pid: 5150 }
  }
  const released = vi.fn(() => {
    order.push('release')
  })
  const holdForMenu = vi.fn<() => () => void>(() => {
    order.push('hold')
    return released
  })
  const expectNew = vi.fn()
  const log = { warn: vi.fn() }
  const deps: CanvasMenuServiceDeps = {
    host: () => host,
    windowOf: (senderId) =>
      senderId === 3 ? { displayId: 7, hwnd: 0x4242n, origin: { x: 2560, y: 0 } } : null,
    dipToScreenPoint: (point) => ({ x: point.x * 1.5, y: point.y * 1.5 }),
    peek: () => ({ holdForMenu }),
    newItems: { expect: expectNew },
    desktopViewCommand: () => true,
    itemPaths: (ids) => ids.map((id) => ITEM_PATHS[id] ?? null),
    log
  }
  return {
    service: createCanvasMenuService(deps),
    host,
    deps,
    holdForMenu,
    released,
    expectNew,
    log,
    order
  }
}

describe('createCanvasMenuService (the native Desktop background menu)', () => {
  it('shows the Desktop background menu with Taskyard’s policy at the physical point', async () => {
    const { service, host } = setup()
    await service.show(3, { ...REQUEST, extendedVerbs: true })
    expect(host.show).toHaveBeenCalledOnce()
    expect(host.built).toEqual([
      {
        target: { kind: 'desktop-background' },
        // (2560 + 100.5, 0 + 40) DIP × 1.5, rounded to whole physical pixels.
        point: { x: 3991, y: 60 },
        extendedVerbs: true,
        ...backgroundMenuPolicy(REQUEST.state),
        returnFocusTo: String(0x4242n)
      }
    ])
  })

  it('replaces a menu still open or queued (cancelShows) before asking for the new one', async () => {
    const { service, order } = setup()
    await service.show(3, REQUEST)
    expect(order).toEqual(['cancel', 'hold', 'show', 'release'])
  })

  it('holds a Peek while the menu is up (released once it closed, whatever happened)', async () => {
    const { service, holdForMenu, released } = setup()
    await service.show(3, REQUEST)
    expect(holdForMenu).toHaveBeenCalledOnce()
    expect(released).toHaveBeenCalledOnce()
  })

  it('passes Taskyard, intercepted and dismissed outcomes through', async () => {
    for (const outcome of [
      { kind: 'dismissed' },
      { kind: 'taskyard', id: 'view.icon-small' },
      { kind: 'intercepted', verb: 'refresh', label: 'Refresh', path: [] }
    ] as ShowMenuOutcome[]) {
      const { service, expectNew } = setup(outcome)
      await expect(service.show(3, REQUEST)).resolves.toEqual(outcome)
      expect(expectNew).not.toHaveBeenCalled()
    }
  })

  it('arms the new-item placement after New ▸, at the window’s CSS point', async () => {
    const folder = setup({ kind: 'invoked', verb: 'NewFolder', label: 'Folder', path: ['New'] })
    await folder.service.show(3, REQUEST)
    expect(folder.expectNew).toHaveBeenCalledExactlyOnceWith({
      displayId: 7,
      point: { x: 100.5, y: 40 },
      rename: true
    })

    const link = setup({ kind: 'invoked', verb: 'NewLink', label: 'Shortcut', path: ['New'] })
    await link.service.show(3, REQUEST)
    expect(link.expectNew).toHaveBeenCalledWith(expect.objectContaining({ rename: false }))

    const settings = setup({
      kind: 'invoked',
      verb: 'Display',
      label: 'Display settings',
      path: []
    })
    await settings.service.show(3, REQUEST)
    expect(settings.expectNew).not.toHaveBeenCalled()
  })

  it('runs Undo and Paste through Explorer’s desktop view (the windowless view cannot)', async () => {
    for (const verb of ['undo', 'paste'] as const) {
      const outcome: ShowMenuOutcome = { kind: 'intercepted', verb, label: verb, path: [] }
      const { service, deps } = setup(outcome)
      const desktopViewCommand = vi.fn(() => true)
      deps.desktopViewCommand = desktopViewCommand
      await expect(service.show(3, REQUEST)).resolves.toEqual(outcome)
      expect(desktopViewCommand).toHaveBeenCalledExactlyOnceWith(verb)
    }
  })

  it('arms the new-item placement after Paste (Explorer pastes into the user’s Desktop folder)', async () => {
    const { service, expectNew } = setup({
      kind: 'intercepted',
      verb: 'paste',
      label: 'Paste',
      path: []
    })
    await service.show(3, REQUEST)
    expect(expectNew).toHaveBeenCalledExactlyOnceWith({
      displayId: 7,
      point: { x: 100.5, y: 40 },
      rename: false
    })
  })

  it('tells the user when Explorer’s desktop is not there to run it', async () => {
    const { service, deps, log, expectNew } = setup({
      kind: 'intercepted',
      verb: 'paste',
      label: 'Paste',
      path: []
    })
    deps.desktopViewCommand = () => false
    await expect(service.show(3, REQUEST)).resolves.toEqual({
      kind: 'invoke-failed',
      verb: 'paste',
      label: 'Paste',
      path: [],
      message: 'Explorer’s desktop is not running.'
    })
    expect(expectNew).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Paste'), expect.any(String))
  })

  it('logs and returns a failed invoke (the renderer tells the user; no fallback menu)', async () => {
    const failed: ShowMenuOutcome = {
      kind: 'invoke-failed',
      verb: 'paste',
      label: 'Paste',
      path: [],
      message: 'Access is denied.'
    }
    const { service, log } = setup(failed)
    await expect(service.show(3, REQUEST)).resolves.toEqual(failed)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Paste'), 'Access is denied.')
  })

  it('falls back to Taskyard’s menu when the helper fails, times out or died', async () => {
    for (const code of ['timeout', 'helper-exited', 'helper-failed', 'request-failed'] as const) {
      const { service, log, released } = setup(new ShellMenuError(code, `it ${code}`))
      await expect(service.show(3, REQUEST)).resolves.toEqual({ kind: 'fallback', reason: code })
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(code), `it ${code}`)
      expect(released).toHaveBeenCalledOnce()
    }
  })

  it('reports a menu a newer right-click replaced as superseded (nothing opens)', async () => {
    const { service, log } = setup(new ShellMenuError('cancelled', 'replaced'))
    await expect(service.show(3, REQUEST)).resolves.toEqual({ kind: 'superseded' })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('falls back at once without a helper (fake Win32, native menus off)', async () => {
    const { service, deps } = setup()
    deps.host = () => null
    expect(service.available()).toBe(false)
    await expect(service.show(3, REQUEST)).resolves.toEqual({
      kind: 'fallback',
      reason: 'unavailable'
    })
  })

  it('refuses a request from an unknown window or for another display', async () => {
    const { service, host } = setup()
    expect(service.available()).toBe(true)
    await expect(service.show(9, REQUEST)).resolves.toEqual({
      kind: 'fallback',
      reason: 'unknown-window'
    })
    await expect(service.show(3, { ...REQUEST, displayId: 8 })).resolves.toEqual({
      kind: 'fallback',
      reason: 'unknown-window'
    })
    expect(host.show).not.toHaveBeenCalled()
  })

  it('works before Peek exists (no hold to take)', async () => {
    const { service, deps } = setup({ kind: 'taskyard', id: 'taskyard.quit' })
    deps.peek = () => null
    await expect(service.show(3, REQUEST)).resolves.toEqual({
      kind: 'taskyard',
      id: 'taskyard.quit'
    })
  })
})

describe('registerShellMenuIpc', () => {
  let ipc: FakeIpcMain
  let service: { show: Mock; available: Mock }
  const log = { warn: vi.fn() }

  beforeEach(() => {
    ipc = new FakeIpcMain()
    service = { show: vi.fn(async () => ({ kind: 'dismissed' })), available: vi.fn(() => true) }
    registerShellMenuIpc(
      ipc,
      { isTrustedSender: (event) => event.senderFrame?.url === TRUSTED_RENDERER_URL, log },
      service
    )
  })

  const from = (
    senderId: number,
    url = TRUSTED_RENDERER_URL
  ): { sender: { id: number }; senderFrame: { url: string } } => ({
    sender: { id: senderId },
    senderFrame: { url }
  })

  it('passes a valid request with the sender’s webContents id', async () => {
    await expect(ipc.invokeFrom(from(3), SHELL_MENU_IPC.show, REQUEST)).resolves.toEqual({
      kind: 'dismissed'
    })
    expect(service.show).toHaveBeenCalledExactlyOnceWith(3, REQUEST)
    await expect(ipc.invokeFrom(from(3), SHELL_MENU_IPC.available)).resolves.toBe(true)
  })

  it('rejects malformed requests and never forwards them (the renderer never sends paths)', async () => {
    const bad: unknown[] = [
      [],
      [null],
      [{ ...REQUEST, kind: 'items' }],
      [{ ...REQUEST, point: { x: Number.NaN, y: 0 } }],
      [{ ...REQUEST, state: { ...REQUEST.state, iconSize: 'huge' } }],
      [{ ...REQUEST, path: 'C:\\Windows' }],
      [REQUEST, 'extra']
    ]
    for (const args of bad) {
      await expect(
        ipc.invokeFrom(from(3), SHELL_MENU_IPC.show, ...(args as unknown[]))
      ).rejects.toThrow(/invalid arguments/)
    }
    expect(service.show).not.toHaveBeenCalled()
  })

  it('refuses other senders', async () => {
    await expect(
      ipc.invokeFrom(from(3, 'https://example.com/'), SHELL_MENU_IPC.show, REQUEST)
    ).rejects.toThrow(/untrusted/)
    await expect(
      ipc.invokeFrom(from(3, 'https://example.com/'), SHELL_MENU_IPC.available)
    ).rejects.toThrow(/untrusted/)
    expect(service.show).not.toHaveBeenCalled()
  })
})

describe('createCanvasMenuService: an icon’s native file menu (Phase 4)', () => {
  it('shows the file menu for the ids’ current paths (right-clicked first) with the item policy', async () => {
    const { service, host, order } = setup()
    await service.show(3, { ...ITEMS_REQUEST, extendedVerbs: true })
    expect(host.show).toHaveBeenCalledOnce()
    expect(host.built).toEqual([
      {
        target: {
          kind: 'items',
          paths: ['C:/Users/me/Desktop/b.txt', 'C:/Users/me/Desktop/a.txt']
        },
        point: { x: 3991, y: 60 },
        extendedVerbs: true,
        ...itemMenuPolicy(ITEMS_REQUEST.kind === 'items' ? ITEMS_REQUEST.state : null!),
        returnFocusTo: String(0x4242n)
      }
    ])
    // The same replace-the-open-menu and Peek rules as the desktop menu.
    expect(order).toEqual(['cancel', 'hold', 'show', 'release'])
  })

  it('leaves out ids main does not know (gone since), keeping the right-clicked one first', async () => {
    const { service, host } = setup()
    await service.show(3, { ...ITEMS_REQUEST, ids: ['1:1', 'gone:1', '1:2'] })
    expect(host.built[0].target).toEqual({
      kind: 'items',
      paths: ['C:/Users/me/Desktop/a.txt', 'C:/Users/me/Desktop/b.txt']
    })
  })

  it('falls back when main does not know the right-clicked item', async () => {
    const { service, host, log } = setup()
    await expect(service.show(3, { ...ITEMS_REQUEST, ids: ['gone:1', '1:1'] })).resolves.toEqual({
      kind: 'fallback',
      reason: 'unknown-items'
    })
    expect(host.built).toEqual([])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('gone:1'))
  })

  it('Phase 4 review: looks the paths up when the helper takes the request, not when it is queued', async () => {
    const { service, host, deps } = setup()
    const itemPaths = vi.fn(deps.itemPaths)
    deps.itemPaths = itemPaths
    let take: () => void = () => {}
    host.show.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          // Queued behind another menu: taken later.
          take = () => {
            host.built.push(typeof request === 'function' ? request() : request)
            resolve({ kind: 'dismissed' })
          }
        })
    )
    const shown = service.show(3, ITEMS_REQUEST)
    await Promise.resolve()
    expect(itemPaths).not.toHaveBeenCalled()
    take()
    await shown
    expect(itemPaths).toHaveBeenCalledExactlyOnceWith(['1:2', '1:1'])
    expect(host.built[0].target).toEqual({
      kind: 'items',
      paths: ['C:/Users/me/Desktop/b.txt', 'C:/Users/me/Desktop/a.txt']
    })
  })

  it('places a shortcut made by Create shortcut next to the click; nothing else is placed', async () => {
    const link = setup({ kind: 'invoked', verb: 'link', label: 'Create shortcut', path: [] })
    await link.service.show(3, ITEMS_REQUEST)
    expect(link.expectNew).toHaveBeenCalledExactlyOnceWith({
      displayId: 7,
      point: { x: 100.5, y: 40 },
      rename: false
    })
    // A Paste chosen on a folder item pastes into that folder (not the Desktop): nothing placed,
    // and never through Explorer's desktop view.
    for (const outcome of [
      { kind: 'invoked', verb: 'paste', label: 'Paste', path: [] },
      { kind: 'invoked', verb: 'delete', label: 'Delete', path: [] },
      { kind: 'intercepted', verb: 'rename', label: 'Rename', path: [] }
    ] as ShowMenuOutcome[]) {
      const { service, expectNew, deps } = setup(outcome)
      const desktopViewCommand = vi.fn(() => true)
      deps.desktopViewCommand = desktopViewCommand
      await expect(service.show(3, ITEMS_REQUEST)).resolves.toEqual(outcome)
      expect(expectNew).not.toHaveBeenCalled()
      expect(desktopViewCommand).not.toHaveBeenCalled()
    }
  })

  it('falls back like the desktop menu when the helper fails; superseded when replaced', async () => {
    const failed = setup(new ShellMenuError('timeout', 'slow'))
    await expect(failed.service.show(3, ITEMS_REQUEST)).resolves.toEqual({
      kind: 'fallback',
      reason: 'timeout'
    })
    const replaced = setup(new ShellMenuError('cancelled', 'replaced'))
    await expect(replaced.service.show(3, ITEMS_REQUEST)).resolves.toEqual({ kind: 'superseded' })
  })
})

describe('registerShellMenuIpc: icon menu requests', () => {
  let ipc: FakeIpcMain
  let service: { show: Mock; available: Mock }
  const log = { warn: vi.fn() }

  beforeEach(() => {
    ipc = new FakeIpcMain()
    service = { show: vi.fn(async () => ({ kind: 'dismissed' })), available: vi.fn(() => true) }
    registerShellMenuIpc(
      ipc,
      { isTrustedSender: (event) => event.senderFrame?.url === TRUSTED_RENDERER_URL, log },
      service
    )
  })
  const sender = { sender: { id: 3 }, senderFrame: { url: TRUSTED_RENDERER_URL } }

  it('passes a valid items request (ids, never paths)', async () => {
    await ipc.invokeFrom(sender, SHELL_MENU_IPC.show, ITEMS_REQUEST)
    expect(service.show).toHaveBeenCalledExactlyOnceWith(3, ITEMS_REQUEST)
  })

  it('rejects items requests with paths, no ids, bad ids or a background state', async () => {
    const bad: unknown[] = [
      { ...ITEMS_REQUEST, ids: [] },
      { ...ITEMS_REQUEST, ids: ['C:/Windows/notepad.exe'] },
      { ...ITEMS_REQUEST, paths: ['C:/Windows'] },
      { ...ITEMS_REQUEST, state: { inGroup: true } },
      { ...ITEMS_REQUEST, state: REQUEST.kind === 'background' ? REQUEST.state : null },
      { ...REQUEST, ids: ['1:1'] }
    ]
    for (const request of bad) {
      await expect(ipc.invokeFrom(sender, SHELL_MENU_IPC.show, request)).rejects.toThrow(
        /invalid arguments/
      )
    }
    expect(service.show).not.toHaveBeenCalled()
  })
})
