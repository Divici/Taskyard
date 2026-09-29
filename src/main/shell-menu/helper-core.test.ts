import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { createFakeShellMenuApi, findItem, type FakeShellMenuApi } from '../win32/shell-menu-fake'
import type { ShellMenuItem, ShellMenuTarget } from '../win32/shell-menu-api'
import { ComError } from '../win32/com'
import { HRESULT_ERROR_CANCELLED } from '../win32/shell-menu-shape'
import {
  createHelperCore,
  PUMP_BUSY_MS,
  PUMP_BUSY_WINDOW_MS,
  PUMP_IDLE_MS,
  runHelper,
  warmUpShellMenu
} from './helper-core'
import type { HelperMessage, HelperRequest } from './protocol'

const FOLDER: ShellMenuTarget = { kind: 'folder-background', path: 'C:\\Temp\\spike' }
const FILES: ShellMenuTarget = { kind: 'items', paths: ['C:\\Temp\\spike\\a.txt'] }

function show(
  id: number,
  overrides: Partial<Extract<HelperRequest, { type: 'show' }>> = {}
): HelperRequest {
  return {
    type: 'show',
    id,
    target: FOLDER,
    point: { x: 100, y: 200 },
    extendedVerbs: false,
    taskyardItems: [
      {
        kind: 'submenu',
        label: 'Taskyard',
        items: [{ kind: 'item', id: 'new-group', label: 'New group here' }]
      }
    ],
    interceptVerbs: ['rename'],
    interceptSubmenus: [],
    hideVerbs: [],
    hideSubmenus: [],
    replaceSubmenus: [],
    ...overrides
  }
}

function setup(options: Parameters<typeof createFakeShellMenuApi>[0] = {}): {
  api: FakeShellMenuApi
  posted: HelperMessage[]
  core: { handle(raw: unknown): void }
} {
  const api = createFakeShellMenuApi(options)
  const posted: HelperMessage[] = []
  const core = createHelperCore({ api, post: (message) => posted.push(message) })
  return { api, posted, core }
}

describe('createHelperCore', () => {
  it('enumerates a menu and posts its items', () => {
    const { api, posted, core } = setup()
    core.handle({ type: 'enumerate', id: 1, target: FOLDER, extendedVerbs: false })
    expect(posted).toEqual([
      {
        type: 'result',
        id: 1,
        result: { kind: 'enumerate', items: api.menuFor(FOLDER, 'shell-view') }
      }
    ])
  })

  it('reports the menu on screen (with its owner window) before the chosen Taskyard item', () => {
    const { posted, core } = setup({
      ownerHwnd: 0x1f2en,
      choose: (menu) => findItem(menu, 'New group here')!.id
    })
    core.handle(show(2))
    expect(posted).toEqual([
      { type: 'showing', id: 2, ownerHwnd: String(0x1f2en) },
      {
        type: 'result',
        id: 2,
        result: { kind: 'show', outcome: { kind: 'taskyard', id: 'new-group' } }
      }
    ])
  })

  it('invokes a chosen shell verb in the helper and reports it', () => {
    const { api, posted, core } = setup({ choose: (menu) => findItem(menu, 'Delete')!.id })
    core.handle(show(3, { target: FILES }))
    // Phase 4 review: main hears the menu closed and the command runs before it runs.
    expect(posted[1]).toEqual({ type: 'invoking', id: 3 })
    expect(posted[2]).toEqual({
      type: 'result',
      id: 3,
      result: {
        kind: 'show',
        outcome: { kind: 'invoked', verb: 'delete', label: 'Delete', path: [] }
      }
    })
    expect(api.invoked).toEqual([{ target: FILES, verb: 'delete' }])
  })

  it('hands an intercepted verb back without invoking it (and never says it is invoking)', () => {
    const { api, posted, core } = setup({ choose: (menu) => findItem(menu, 'Rename')!.id })
    core.handle(show(4, { target: FILES }))
    expect(posted.map((message) => message.type)).toEqual(['showing', 'result'])
    expect(posted[1]).toEqual({
      type: 'result',
      id: 4,
      result: {
        kind: 'show',
        outcome: { kind: 'intercepted', verb: 'rename', label: 'Rename', path: [] }
      }
    })
    expect(api.invoked).toEqual([])
  })

  it('removes hidden verbs and submenus from the menu before it shows', () => {
    const seen: string[] = []
    const { core } = setup({
      choose: (menu) => {
        seen.push(...menu.map((entry) => entry.label))
        return 0
      }
    })
    core.handle(show(5, { hideVerbs: ['viewcustomwizard'], hideSubmenus: ['sortascending'] }))
    expect(seen).not.toContain('Customize this folder...')
    expect(seen).not.toContain('Sort by')
    expect(seen).toEqual(expect.arrayContaining(['Taskyard', 'View', 'Paste']))
  })

  it('replaces a shell submenu in place with Taskyard items; a click on one maps back to its id', () => {
    const seen: ShellMenuItem[][] = []
    const { api, posted, core } = setup({
      choose: (menu) => {
        seen.push(menu)
        return findItem(menu, 'Small icons')!.id
      }
    })
    core.handle(
      show(10, {
        replaceSubmenus: [
          {
            match: { verb: 'viewlogicaliconslarge' },
            items: [
              {
                kind: 'item',
                id: 'icon-large',
                label: 'Large',
                labelFrom: { verb: 'viewlogicaliconslarge' },
                radio: true
              },
              {
                kind: 'item',
                id: 'icon-small',
                label: 'Small',
                labelFrom: { verb: 'viewlogicaliconssmall' },
                radio: true,
                checked: true
              }
            ]
          }
        ]
      })
    )
    const view = seen[0].find((entry) => entry.label === 'View')!
    expect(view.submenu!.map((entry) => [entry.label, entry.checked, entry.radio])).toEqual([
      ['Large icons', false, true],
      ['Small icons', true, true]
    ])
    expect(posted[1]).toEqual({
      type: 'result',
      id: 10,
      result: { kind: 'show', outcome: { kind: 'taskyard', id: 'icon-small' } }
    })
    expect(api.invoked).toEqual([])
  })

  it('reports a failed invoke after the user chose as an outcome, not an error', () => {
    const { api, posted, core } = setup({ choose: (menu) => findItem(menu, 'Delete')!.id })
    api.failNextInvoke(
      new ComError('IContextMenu::InvokeCommand failed: HRESULT 0x80070005', 0x80070005 | 0)
    )
    core.handle(show(11, { target: FILES }))
    expect(posted.map((message) => message.type)).toEqual(['showing', 'invoking', 'result'])
    expect(posted[2]).toEqual({
      type: 'result',
      id: 11,
      result: {
        kind: 'show',
        outcome: {
          kind: 'invoke-failed',
          verb: 'delete',
          label: 'Delete',
          path: [],
          message: 'IContextMenu::InvokeCommand failed: HRESULT 0x80070005'
        }
      }
    })
  })

  it('counts a cancelled invoke (ERROR_CANCELLED: UAC or a dialog cancelled) as invoked', () => {
    const { api, posted, core } = setup({ choose: (menu) => findItem(menu, 'Delete')!.id })
    api.failNextInvoke(new ComError('cancelled', HRESULT_ERROR_CANCELLED))
    core.handle(show(12, { target: FILES }))
    expect(posted[2]).toMatchObject({
      result: { outcome: { kind: 'invoked', verb: 'delete' } }
    })
  })

  it('never turns a failure after the menu showed into a rejection (the user already chose)', () => {
    const { posted, core } = setup({
      choose: () => {
        throw new Error('GetMenuItemInfoW blew up')
      }
    })
    core.handle(show(13))
    expect(posted).toEqual([
      { type: 'showing', id: 13, ownerHwnd: expect.any(String) },
      {
        type: 'result',
        id: 13,
        result: {
          kind: 'show',
          outcome: {
            kind: 'invoke-failed',
            verb: null,
            label: '',
            path: [],
            message: 'GetMenuItemInfoW blew up'
          }
        }
      }
    ])
  })

  it('never reads the clipboard or asks a drop target for enumerate or preview; show does, once', () => {
    const pasteSeen: boolean[] = []
    const { api, posted, core } = setup({
      clipboardPasteable: true,
      choose: (menu) => {
        pasteSeen.push(!findItem(menu, 'Paste')!.disabled)
        return 0
      }
    })
    core.handle({ type: 'enumerate', id: 20, target: FOLDER, extendedVerbs: false })
    api.preview(show(21) as Extract<HelperRequest, { type: 'show' }>)
    expect(api.pasteProbes).toBe(0)
    const enumerated = (posted[0] as { result: { items: ShellMenuItem[] } }).result.items
    expect(findItem(enumerated, 'Paste')!.disabled).toBe(true) // the view's own (always grayed) state

    core.handle(show(22))
    expect(api.pasteProbes).toBe(1)
    expect(pasteSeen).toEqual([true])
  })

  it('works out Paste for enumerate only when asked explicitly (pasteState: true)', () => {
    const { api, posted, core } = setup({ clipboardPasteable: true })
    core.handle({
      type: 'enumerate',
      id: 23,
      target: FOLDER,
      extendedVerbs: false,
      pasteState: true
    })
    expect(api.pasteProbes).toBe(1)
    const items = (posted[0] as { result: { items: ShellMenuItem[] } }).result.items
    expect(findItem(items, 'Paste')!.disabled).toBe(false)
  })

  it('never probes the clipboard for file menus', () => {
    const { api, core } = setup({ clipboardPasteable: true })
    core.handle(show(24, { target: FILES }))
    expect(api.pasteProbes).toBe(0)
  })

  it('reports an error before any menu shows when it cannot take the foreground (main falls back)', () => {
    const { api, posted, core } = setup({ foreground: false })
    core.handle(show(1))
    expect(posted).toEqual([
      { type: 'error', id: 1, message: expect.stringMatching(/foreground/i) }
    ])
    expect(api.shown).toHaveLength(0)
  })

  it('gives the foreground back to the window main named when the outcome allows it', () => {
    const { api, core } = setup({ choose: (menu) => findItem(menu, 'New group here')!.id })
    core.handle(show(1, { returnFocusTo: '4660' }))
    expect(api.focusReturns).toEqual([4660n])

    api.setChoice((menu) => findItem(menu, 'Properties')!.id)
    core.handle(show(2, { returnFocusTo: '4660' }))
    // Properties opens a dialog of its own: it keeps the foreground.
    expect(api.focusReturns).toEqual([4660n])

    api.setChoice(() => 0)
    core.handle(show(3))
    // Nobody named: nothing to give back.
    expect(api.focusReturns).toEqual([4660n])
  })

  it('invokes Paste of a background menu by its verb, a file menu’s commands by id', () => {
    const { api, core } = setup({
      clipboardPasteable: true,
      choose: (menu) => findItem(menu, 'Paste')!.id
    })
    core.handle(show(1))
    api.setChoice((menu) => findItem(menu, 'Delete')!.id)
    core.handle(show(2, { target: FILES }))
    expect(api.invoked).toEqual([
      { target: FOLDER, verb: 'paste' },
      { target: FILES, verb: 'delete' }
    ])
    expect(api.invokedBy).toEqual(['verb', 'id'])
  })

  it('invokes a verb without showing a menu', () => {
    const { api, posted, core } = setup()
    core.handle({ type: 'invoke', id: 6, target: FILES, verb: 'properties' })
    expect(posted).toEqual([{ type: 'result', id: 6, result: { kind: 'invoke' } }])
    expect(api.invoked).toEqual([{ target: FILES, verb: 'properties' }])
    expect(api.shown).toEqual([])
  })

  it('reports a failing request as an error and keeps serving', () => {
    const { api, posted, core } = setup()
    api.failNext(new Error('SHParseDisplayName failed: HRESULT 0x80070002'))
    core.handle({ type: 'invoke', id: 7, target: FILES, verb: 'properties' })
    core.handle({ type: 'invoke', id: 8, target: FILES, verb: 'properties' })
    expect(posted).toEqual([
      { type: 'error', id: 7, message: 'SHParseDisplayName failed: HRESULT 0x80070002' },
      { type: 'result', id: 8, result: { kind: 'invoke' } }
    ])
  })

  it('answers an invalid request with an error for its id, or a crash report without one', () => {
    const { posted, core } = setup()
    core.handle({ type: 'invoke', id: 9, target: FILES, verb: '' })
    core.handle({ nonsense: true })
    expect(posted).toHaveLength(2)
    expect(posted[0]).toMatchObject({ type: 'error', id: 9 })
    expect((posted[0] as { message: string }).message).toMatch(/^invalid request/)
    expect(posted[1]).toMatchObject({ type: 'crash' })
    expect((posted[1] as { message: string }).message).toMatch(/^invalid request/)
  })
})

/** A stand-in for the utility process's `process` (events, pid, exit). */
function fakeProcess(pid: number): EventEmitter & { pid: number; exit: Mock } {
  return Object.assign(new EventEmitter(), { pid, exit: vi.fn() })
}

class FakePort extends EventEmitter {
  readonly posted: HelperMessage[] = []
  postMessage(message: HelperMessage): void {
    this.posted.push(message)
  }
  deliver(data: unknown): void {
    this.emit('message', { data })
  }
}

describe('runHelper (the utility-process entry)', () => {
  it('creates the shell-menu api, then reports ready with its pid and serves requests', async () => {
    const port = new FakePort()
    const proc = fakeProcess(4242)
    const api = createFakeShellMenuApi()
    await runHelper({ port, process: proc, createApi: async () => api })
    expect(port.posted).toEqual([{ type: 'ready', pid: 4242 }])
    port.deliver({ type: 'invoke', id: 1, target: FILES, verb: 'open' })
    expect(port.posted[1]).toEqual({ type: 'result', id: 1, result: { kind: 'invoke' } })
  })

  it('gives the api a log whose warnings reach main', async () => {
    const port = new FakePort()
    const proc = fakeProcess(3)
    await runHelper({
      port,
      process: proc,
      createApi: async (log) => {
        log.warn('a menu message handler threw', new Error('boom'))
        return createFakeShellMenuApi()
      }
    })
    expect(port.posted[0]).toEqual({ type: 'warn', message: 'a menu message handler threw: boom' })
  })

  it('warms up once after ready (the first real menu loads its handlers faster and complete)', async () => {
    const port = new FakePort()
    const proc = fakeProcess(8)
    const api = createFakeShellMenuApi()
    const warmUp = vi.fn((warmed: typeof api) => {
      expect(port.posted).toEqual([{ type: 'ready', pid: 8 }])
      warmed.enumerate({ kind: 'desktop-background' }, { extendedVerbs: false })
    })
    await runHelper({ port, process: proc, createApi: async () => api, warmUp })
    expect(warmUp).toHaveBeenCalledTimes(1)
    expect(warmUp).toHaveBeenCalledWith(api)
  })

  it('the helper\u2019s warm-up builds the Desktop menu without touching the clipboard', () => {
    const api = createFakeShellMenuApi({ clipboardPasteable: true })
    warmUpShellMenu(api)
    expect(api.pasteProbes).toBe(0)
    expect(api.shown).toEqual([])
  })

  it('reports a failed warm-up as a warning and keeps serving', async () => {
    const port = new FakePort()
    const proc = fakeProcess(9)
    await runHelper({
      port,
      process: proc,
      createApi: async () => createFakeShellMenuApi(),
      warmUp: () => {
        throw new Error('SHGetDesktopFolder failed')
      }
    })
    port.deliver({ type: 'invoke', id: 1, target: FILES, verb: 'open' })
    expect(port.posted).toEqual([
      { type: 'ready', pid: 9 },
      { type: 'warn', message: 'warm-up failed: SHGetDesktopFolder failed' },
      { type: 'result', id: 1, result: { kind: 'invoke' } }
    ])
  })

  it('shuts down on request: disposes the api (flushing the clipboard) and exits', async () => {
    const port = new FakePort()
    const proc = fakeProcess(6)
    const api = createFakeShellMenuApi()
    await runHelper({ port, process: proc, createApi: async () => api })
    port.deliver({ type: 'shutdown' })
    expect(api.disposed).toBe(true)
    expect(proc.exit).toHaveBeenCalledWith(0)
  })

  it('disposes the api when the process exits by any graceful path', async () => {
    const port = new FakePort()
    const proc = fakeProcess(7)
    const api = createFakeShellMenuApi()
    await runHelper({ port, process: proc, createApi: async () => api })
    proc.emit('exit', 0)
    expect(api.disposed).toBe(true)
  })

  it('reports fatal when the api cannot be created (koffi missing, COM refused)', async () => {
    const port = new FakePort()
    const proc = fakeProcess(1)
    await runHelper({
      port,
      process: proc,
      createApi: async () => {
        throw new Error('Cannot find the native Koffi module')
      }
    })
    expect(port.posted).toEqual([{ type: 'fatal', message: 'Cannot find the native Koffi module' }])
  })

  it('survives an uncaught error or rejection: reports it and keeps serving', async () => {
    const port = new FakePort()
    const proc = fakeProcess(5)
    await runHelper({ port, process: proc, createApi: async () => createFakeShellMenuApi() })
    proc.emit('uncaughtException', new TypeError('x is undefined'))
    proc.emit('unhandledRejection', 'plain reason')
    port.deliver({ type: 'invoke', id: 2, target: FILES, verb: 'open' })
    expect(port.posted.slice(1)).toEqual([
      { type: 'crash', message: 'TypeError: x is undefined' },
      { type: 'crash', message: 'plain reason' },
      { type: 'result', id: 2, result: { kind: 'invoke' } }
    ])
  })

  it('pumps window messages on the helper thread: fast for a while after each request, slowly when idle', async () => {
    vi.useFakeTimers()
    try {
      const port = new FakePort()
      const proc = fakeProcess(5)
      const api = createFakeShellMenuApi()
      await runHelper({ port, process: proc, createApi: async () => api })
      const idle = api.pumps
      await vi.advanceTimersByTimeAsync(PUMP_IDLE_MS * 4)
      expect(api.pumps - idle).toBe(4)

      port.deliver({ type: 'invoke', id: 1, target: FILES, verb: 'open' })
      const busy = api.pumps
      await vi.advanceTimersByTimeAsync(PUMP_BUSY_MS * 10)
      expect(api.pumps - busy).toBeGreaterThanOrEqual(10)

      await vi.advanceTimersByTimeAsync(PUMP_BUSY_WINDOW_MS)
      const settled = api.pumps
      await vi.advanceTimersByTimeAsync(PUMP_IDLE_MS * 2)
      expect(api.pumps - settled).toBeLessThanOrEqual(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps pumping when one pump throws, and reports it', async () => {
    vi.useFakeTimers()
    try {
      const port = new FakePort()
      const proc = fakeProcess(5)
      const api = createFakeShellMenuApi()
      await runHelper({ port, process: proc, createApi: async () => api })
      api.failNextPump(new Error('DispatchMessageW blew up'))
      await vi.advanceTimersByTimeAsync(PUMP_IDLE_MS * 3)
      expect(port.posted).toContainEqual({ type: 'crash', message: 'DispatchMessageW blew up' })
      expect(api.pumps).toBeGreaterThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never lets a failing post (the port closed) escape the error handler', async () => {
    const port = new FakePort()
    const proc = fakeProcess(5)
    await runHelper({ port, process: proc, createApi: async () => createFakeShellMenuApi() })
    vi.spyOn(port, 'postMessage').mockImplementation(() => {
      throw new Error('port closed')
    })
    expect(() => proc.emit('uncaughtException', new Error('boom'))).not.toThrow()
  })
})
