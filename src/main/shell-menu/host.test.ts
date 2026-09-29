import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createFakeShellMenuApi, findItem } from '../win32/shell-menu-fake'
import type { ShowMenuRequest } from '../win32/shell-menu-api'
import { FakeHelperChild } from './fake-helper-child'
import {
  createShellMenuHost,
  REQUEST_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
  ShellMenuError,
  type HelperChild,
  type ShellMenuHost,
  type ShellMenuHostDeps
} from './host'
import type { HelperRequest } from './protocol'

/** Requests carry an id; `shutdown` (no id) is only ever compared as a whole. */
type Posted = Extract<HelperRequest, { id: number }>

/** A helper child the test drives by hand: it records requests and replies when told. */
class ScriptedChild extends EventEmitter implements HelperChild {
  pid: number | undefined = undefined
  readonly posted: Posted[] = []
  killed = false

  postMessage(message: unknown): void {
    this.posted.push(message as Posted)
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  ready(pid = 4242): void {
    this.pid = pid
    this.emit('message', { type: 'ready', pid })
  }

  reply(message: unknown): void {
    this.emit('message', message)
  }

  exit(code = 1): void {
    this.emit('exit', code)
  }

  last(): Posted {
    return this.posted[this.posted.length - 1]
  }
}

const REQUEST: ShowMenuRequest = {
  target: { kind: 'desktop-background' },
  point: { x: 10, y: 20 },
  extendedVerbs: false,
  taskyardItems: [{ kind: 'item', id: 'new-group', label: 'New group here' }],
  interceptVerbs: ['refresh'],
  interceptSubmenus: [],
  hideVerbs: [],
  hideSubmenus: [],
  replaceSubmenus: []
}

interface Setup {
  host: ShellMenuHost
  children: ScriptedChild[]
  order: string[]
  log: { info: Mock; warn: Mock; error: Mock }
}

function setup(overrides: Partial<ShellMenuHostDeps> = {}): Setup {
  const children: ScriptedChild[] = []
  const order: string[] = []
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const deps: ShellMenuHostDeps = {
    fork: () => {
      const child = new ScriptedChild()
      const post = child.postMessage.bind(child)
      child.postMessage = (message: unknown) => {
        order.push(`post ${(message as HelperRequest).type}`)
        post(message)
      }
      children.push(child)
      return child
    },
    allowForeground: (pid) => order.push(`allow ${pid}`),
    log,
    ...overrides
  }
  const host = createShellMenuHost(deps)
  return { host, children, order, log }
}

/** Lets pending promise callbacks run (host code awaits between steps). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('createShellMenuHost', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('has a 30 s request timeout', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000)
  })

  it('starts one helper and reports its pid once it is ready', async () => {
    const { host, children, log } = setup()
    const started = host.start()
    const again = host.start()
    expect(children).toHaveLength(1)
    children[0].ready(777)
    await expect(started).resolves.toEqual({ pid: 777 })
    await expect(again).resolves.toEqual({ pid: 777 })
    expect(host.helper).toEqual({ pid: 777 })
    expect(log.info).toHaveBeenCalledWith('shell-menu: helper ready (pid 777)')
  })

  it('lets the helper take the foreground right before posting a show request, then resolves its outcome', async () => {
    const { host, children, order } = setup()
    const shown = host.show(REQUEST)
    children[0].ready(900)
    await flush()
    expect(order).toEqual(['allow 900', 'post show'])
    const request = children[0].last()
    expect(request).toEqual({ type: 'show', id: expect.any(Number), ...REQUEST })
    children[0].reply({
      type: 'result',
      id: request.id,
      result: { kind: 'show', outcome: { kind: 'taskyard', id: 'new-group' } }
    })
    await expect(shown).resolves.toEqual({ kind: 'taskyard', id: 'new-group' })
  })

  it('tells showing listeners the owner window while the menu is on screen', async () => {
    const { host, children } = setup()
    const listener = vi.fn()
    const off = host.onShowing(listener)
    void host.show(REQUEST)
    children[0].ready(900)
    await flush()
    children[0].reply({ type: 'showing', id: children[0].last().id, ownerHwnd: '2039016' })
    expect(listener).toHaveBeenCalledWith({ ownerHwnd: 2039016n, pid: 900 })
    off()
    children[0].reply({ type: 'showing', id: children[0].last().id, ownerHwnd: '1' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('passes an explicit pasteState to enumerate, and none by default', async () => {
    const { host, children } = setup()
    void host.enumerate({ kind: 'desktop-background' })
    children[0].ready()
    await flush()
    expect(children[0].last()).not.toHaveProperty('pasteState')
    children[0].reply({
      type: 'result',
      id: children[0].last().id,
      result: { kind: 'enumerate', items: [] }
    })
    await flush()
    void host.enumerate({ kind: 'desktop-background' }, { pasteState: true })
    await flush()
    expect(children[0].last()).toMatchObject({ type: 'enumerate', pasteState: true })
  })

  describe('cancelShows (Phase 3: a new right-click replaces the menu before it)', () => {
    it('rejects show requests still queued as cancelled, and posts none of them', async () => {
      const { host, children } = setup()
      const first = host.show(REQUEST)
      const second = host.show({ ...REQUEST, point: { x: 1, y: 1 } })
      host.cancelShows()
      await expect(first).rejects.toMatchObject({ code: 'cancelled' })
      await expect(second).rejects.toMatchObject({ code: 'cancelled' })
      children[0].ready()
      await flush()
      expect(children[0].posted).toEqual([])
    })

    it('dismisses the menu on screen (WM_CANCELMODE to its owner); its outcome still arrives', async () => {
      const cancelMenu = vi.fn()
      const { host, children } = setup({ cancelMenu })
      const shown = host.show(REQUEST)
      children[0].ready()
      await flush()
      const { id } = children[0].last()
      children[0].reply({ type: 'showing', id, ownerHwnd: '77' })
      host.cancelShows()
      expect(cancelMenu).toHaveBeenCalledWith(77n)
      children[0].reply({
        type: 'result',
        id,
        result: { kind: 'show', outcome: { kind: 'dismissed' } }
      })
      await expect(shown).resolves.toEqual({ kind: 'dismissed' })
    })

    it('dismisses a menu the helper was still building as soon as it shows', async () => {
      const cancelMenu = vi.fn()
      const { host, children } = setup({ cancelMenu })
      void host.show(REQUEST)
      children[0].ready()
      await flush()
      host.cancelShows()
      expect(cancelMenu).not.toHaveBeenCalled()
      children[0].reply({ type: 'showing', id: children[0].last().id, ownerHwnd: '88' })
      expect(cancelMenu).toHaveBeenCalledWith(88n)
    })

    it('leaves enumerate and invoke requests alone', async () => {
      const { host, children } = setup()
      const listed = host.enumerate({ kind: 'desktop-background' })
      const invoked = host.invokeVerb({ kind: 'items', paths: ['C:\\t\\a.txt'] }, 'open')
      host.cancelShows()
      children[0].ready()
      await flush()
      children[0].reply({
        type: 'result',
        id: children[0].last().id,
        result: { kind: 'enumerate', items: [] }
      })
      await expect(listed).resolves.toEqual([])
      await flush()
      children[0].reply({ type: 'result', id: children[0].last().id, result: { kind: 'invoke' } })
      await expect(invoked).resolves.toBeUndefined()
    })
  })

  it('runs requests one at a time, in order', async () => {
    const { host, children } = setup()
    const first = host.enumerate({ kind: 'desktop-background' })
    const second = host.invokeVerb({ kind: 'items', paths: ['C:\\t\\a.txt'] }, 'properties')
    children[0].ready()
    await flush()
    expect(children[0].posted.map((m) => m.type)).toEqual(['enumerate'])
    children[0].reply({
      type: 'result',
      id: children[0].last().id,
      result: { kind: 'enumerate', items: [] }
    })
    await expect(first).resolves.toEqual([])
    await flush()
    expect(children[0].posted.map((m) => m.type)).toEqual(['enumerate', 'invoke'])
    expect(children[0].last()).toMatchObject({ verb: 'properties' })
    children[0].reply({ type: 'result', id: children[0].last().id, result: { kind: 'invoke' } })
    await expect(second).resolves.toBeUndefined()
  })

  it('rejects a request the helper reports as failed, and keeps the helper', async () => {
    const { host, children } = setup()
    const failing = host.invokeVerb({ kind: 'items', paths: ['C:\\t\\gone.txt'] }, 'open')
    children[0].ready()
    await flush()
    children[0].reply({
      type: 'error',
      id: children[0].last().id,
      message: 'SHParseDisplayName failed'
    })
    await expect(failing).rejects.toMatchObject({
      code: 'request-failed',
      message: 'SHParseDisplayName failed'
    })
    const next = host.enumerate({ kind: 'desktop-background' })
    await flush()
    children[0].reply({
      type: 'result',
      id: children[0].last().id,
      result: { kind: 'enumerate', items: [] }
    })
    await expect(next).resolves.toEqual([])
    expect(children).toHaveLength(1)
  })

  it('rejects the active request when the helper dies, and respawns on the next request', async () => {
    const { host, children, log } = setup()
    const shown = host.show(REQUEST)
    children[0].ready(1)
    await flush()
    children[0].reply({ type: 'showing', id: children[0].last().id, ownerHwnd: '5' })
    children[0].exit(0xc0000005)
    await expect(shown).rejects.toMatchObject({ code: 'helper-exited' })
    expect(host.helper).toBeNull()
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('helper exited (code 3221225477)')
    )

    const next = host.enumerate({ kind: 'desktop-background' })
    expect(children).toHaveLength(2)
    children[1].ready(2)
    await flush()
    children[1].reply({
      type: 'result',
      id: children[1].last().id,
      result: { kind: 'enumerate', items: [] }
    })
    await expect(next).resolves.toEqual([])
  })

  it('times a request out after 30 s with no menu shown, and kills the hung helper', async () => {
    const { host, children } = setup()
    const shown = host.show(REQUEST)
    const rejected = expect(shown).rejects.toMatchObject({ code: 'timeout' })
    children[0].ready()
    await flush()
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1)
    expect(children[0].killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(children[0].killed).toBe(true)
    // A menu that shows up late (after the kill) is not ours any more.
    children[0].reply({ type: 'showing', id: children[0].posted[0].id, ownerHwnd: '9' })
    void host.enumerate({ kind: 'desktop-background' })
    expect(children).toHaveLength(2)
  })

  it('times out while waiting for a helper that never becomes ready', async () => {
    const { host, children } = setup()
    const shown = host.show(REQUEST)
    const rejected = expect(shown).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
    await rejected
    expect(children[0].killed).toBe(true)
    expect(children[0].posted).toEqual([])
  })

  it('never times out a menu that is on screen (the user may take their time)', async () => {
    const { host, children } = setup()
    const shown = host.show(REQUEST)
    children[0].ready()
    await flush()
    const id = children[0].last().id
    children[0].reply({ type: 'showing', id, ownerHwnd: '5' })
    await vi.advanceTimersByTimeAsync(5 * REQUEST_TIMEOUT_MS)
    children[0].reply({
      type: 'result',
      id,
      result: { kind: 'show', outcome: { kind: 'dismissed' } }
    })
    await expect(shown).resolves.toEqual({ kind: 'dismissed' })
    expect(children[0].killed).toBe(false)
  })

  it('times out a request queued behind an open menu without killing the helper', async () => {
    const { host, children } = setup()
    void host.show(REQUEST)
    children[0].ready()
    await flush()
    const id = children[0].last().id
    children[0].reply({ type: 'showing', id, ownerHwnd: '5' })
    const queued = host.show(REQUEST)
    const rejected = expect(queued).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
    await rejected
    expect(children[0].killed).toBe(false)
    children[0].reply({
      type: 'result',
      id,
      result: { kind: 'show', outcome: { kind: 'dismissed' } }
    })
    await flush()
    expect(children[0].posted.map((m) => m.type)).toEqual(['show'])
  })

  it('rejects when the helper cannot start (fatal), kills it, and tries again on the next request', async () => {
    const { host, children, log } = setup()
    const started = host.start()
    children[0].reply({ type: 'fatal', message: 'Cannot find the native Koffi module' })
    await expect(started).rejects.toMatchObject({ code: 'helper-failed' })
    expect(children[0].killed).toBe(true)
    expect(log.error).toHaveBeenCalledWith(
      'shell-menu: helper failed to start: Cannot find the native Koffi module'
    )
    void host.start()
    expect(children).toHaveLength(2)
  })

  it('rejects when the helper cannot even be forked', async () => {
    const { host } = setup({
      fork: () => {
        throw new Error('spawn EACCES')
      }
    })
    await expect(host.show(REQUEST)).rejects.toMatchObject({
      code: 'helper-failed',
      message: 'spawn EACCES'
    })
  })

  it('logs a crash report from the helper and keeps using it', async () => {
    const { host, children, log } = setup()
    void host.start()
    children[0].ready()
    children[0].reply({ type: 'crash', message: 'TypeError: x is undefined' })
    expect(log.error).toHaveBeenCalledWith(
      'shell-menu: helper reported an error: TypeError: x is undefined'
    )
    expect(children[0].killed).toBe(false)
  })

  it('logs the helper’s warnings through main’s log (a packaged helper has no console)', async () => {
    const { host, children, log } = setup()
    void host.start()
    children[0].ready()
    children[0].reply({ type: 'warn', message: 'cleanup failed: Error: x' })
    expect(log.warn).toHaveBeenCalledWith('shell-menu: helper: cleanup failed: Error: x')
  })

  it('fails what waited for a helper that died while starting, without respawning in a loop', async () => {
    const { host, children } = setup()
    const shown = host.show(REQUEST)
    children[0].exit(1)
    await expect(shown).rejects.toMatchObject({ code: 'helper-exited' })
    expect(children).toHaveLength(1)
  })

  it('logs and ignores malformed helper messages', async () => {
    const { host, children, log } = setup()
    void host.start()
    children[0].reply({ type: 'ready' })
    expect(log.warn).toHaveBeenCalledWith(
      'shell-menu: ignored a malformed helper message',
      expect.anything()
    )
    expect(host.helper).toBeNull()
  })

  it('dispose does not kill a helper that exits by itself within the grace period', async () => {
    const { host, children } = setup()
    void host.start()
    children[0].ready()
    host.dispose()
    children[0].exit(0)
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS)
    expect(children[0].killed).toBe(false)
  })

  it('dispose kills a helper that is not ready yet at once', async () => {
    const { host, children } = setup()
    void host.start().catch(() => undefined)
    host.dispose()
    expect(children[0].killed).toBe(true)
    expect(children[0].posted).toEqual([])
  })

  it('dispose kills the helper and rejects every request, now and later', async () => {
    const { host, children } = setup()
    const shown = host.show(REQUEST)
    const queued = host.enumerate({ kind: 'desktop-background' })
    children[0].ready()
    await flush()
    host.dispose()
    await expect(shown).rejects.toMatchObject({ code: 'disposed' })
    await expect(queued).rejects.toMatchObject({ code: 'disposed' })
    // A ready helper is asked to shut down first (it flushes the clipboard), then killed.
    expect(children[0].last()).toEqual({ type: 'shutdown' })
    expect(children[0].killed).toBe(false)
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS)
    expect(children[0].killed).toBe(true)
    await expect(host.start()).rejects.toBeInstanceOf(ShellMenuError)
    await expect(host.show(REQUEST)).rejects.toMatchObject({ code: 'disposed' })
    expect(children).toHaveLength(1)
  })
})

describe('createShellMenuHost with the helper core and the fake shell menu', () => {
  it('shows a menu end to end: Taskyard ids map back, shell verbs are invoked in the helper', async () => {
    const api = createFakeShellMenuApi({ choose: (menu) => findItem(menu, 'New group here')!.id })
    const allowForeground = vi.fn()
    const host = createShellMenuHost({
      fork: () => new FakeHelperChild({ api, pid: 31337 }),
      allowForeground,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })
    await expect(host.show(REQUEST)).resolves.toEqual({ kind: 'taskyard', id: 'new-group' })
    expect(allowForeground).toHaveBeenCalledWith(31337)

    api.setChoice((menu) => findItem(menu, 'Paste')!.id)
    await expect(host.show(REQUEST)).resolves.toEqual({
      kind: 'invoked',
      verb: 'paste',
      label: 'Paste',
      path: []
    })
    expect(api.invoked).toEqual([{ target: REQUEST.target, verb: 'paste' }])
    host.dispose()
  })

  it('respawns after the fake helper crashes', async () => {
    const children: FakeHelperChild[] = []
    const host = createShellMenuHost({
      fork: () => {
        const child = new FakeHelperChild({ pid: 100 + children.length })
        children.push(child)
        return child
      },
      allowForeground: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })
    await host.start()
    children[0].crash()
    await new Promise((resolve) => setImmediate(resolve))
    expect(host.helper).toBeNull()
    await expect(host.enumerate({ kind: 'desktop-background' })).resolves.not.toHaveLength(0)
    expect(children).toHaveLength(2)
    expect(host.helper).toEqual({ pid: 101 })
    host.dispose()
  })
})
