import { describe, expect, it, vi } from 'vitest'
import { EVENT_CHANNELS } from '@shared/ipc'
import { defaultSettings } from '@shared/defaults'
import { createTaskyardApi, type IpcRendererLike } from './bridge'

type Listener = (event: unknown, ...args: unknown[]) => void

function fakeIpcRenderer(): IpcRendererLike & {
  invoke: ReturnType<typeof vi.fn>
  listeners: Map<string, Set<Listener>>
  dispatch(channel: string, payload: unknown): void
} {
  const listeners = new Map<string, Set<Listener>>()
  return {
    listeners,
    invoke: vi.fn(async () => 'result'),
    on(channel: string, listener: Listener) {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(listener)
    },
    removeListener(channel: string, listener: Listener) {
      listeners.get(channel)?.delete(listener)
    },
    dispatch(channel: string, payload: unknown) {
      for (const listener of listeners.get(channel) ?? []) {
        listener({ sender: 'ipc-renderer-event-object' }, payload)
      }
    }
  }
}

const versions = { electron: '44.4.5', chrome: '150', node: '24' }

describe('createTaskyardApi', () => {
  it('exposes the process versions', () => {
    expect(createTaskyardApi(fakeIpcRenderer(), versions).versions).toEqual(versions)
  })

  it('maps each method to its request channel', async () => {
    const ipc = fakeIpcRenderer()
    const api = createTaskyardApi(ipc, versions)
    const settings = defaultSettings()

    await api.storage.load('layout')
    await api.storage.save('settings', { baseRevision: 3, data: settings })
    await api.storage.status()
    await api.app.quit()
    await api.app.openExternal('ms-settings:display')
    await api.display.get(2528732444)
    await api.display.list()
    await api.desktop.list()
    await api.desktop.open('1:2')
    await api.desktop.showInFolder('1:2')
    await api.desktop.rename('1:2', 'b.txt')
    await api.desktop.trash('1:2')
    await api.desktop.moveToDesktop(['D:\\a.txt'])
    await api.desktop.undoMove('token-1')
    await api.desktop.rescan()
    await api.theme.get()
    await api.wallpaper.get(2528732444)
    await api.desktop.icons()
    await api.desktop.startDrag(['1:2', '1:3'])
    await api.desktop.cursorOverOtherWindow()

    expect(ipc.invoke.mock.calls).toEqual([
      ['storage:load', 'layout'],
      ['storage:save', 'settings', { baseRevision: 3, data: settings }],
      ['storage:status'],
      ['app:quit'],
      ['app:openExternal', 'ms-settings:display'],
      ['display:get', 2528732444],
      ['display:list'],
      ['desktop:list'],
      ['desktop:open', '1:2'],
      ['desktop:showInFolder', '1:2'],
      ['desktop:rename', '1:2', 'b.txt'],
      ['desktop:trash', '1:2'],
      ['desktop:moveToDesktop', ['D:\\a.txt']],
      ['desktop:undoMove', 'token-1'],
      ['desktop:rescan'],
      ['theme:get'],
      ['wallpaper:get', 2528732444],
      ['desktop:icons'],
      ['desktop:startDrag', ['1:2', '1:3']],
      ['desktop:cursorOverOtherWindow']
    ])
  })

  it('resolves a dropped File to its path with webUtils (Phase 8 Explorer drop)', () => {
    const getPathForFile = vi.fn(() => 'D:\\Photos\\a.jpg')
    const api = createTaskyardApi(fakeIpcRenderer(), versions, { getPathForFile })
    const file = new File(['x'], 'a.jpg')

    expect(api.desktop.pathForFile(file)).toBe('D:\\Photos\\a.jpg')
    expect(getPathForFile).toHaveBeenCalledExactlyOnceWith(file)
  })

  it('maps the Peek and quick-hide methods to their channels (Phase 9)', async () => {
    const ipc = fakeIpcRenderer()
    const api = createTaskyardApi(ipc, versions)
    await api.peek.get()
    await api.peek.inputFocus(true)
    await api.peek.activity()
    await api.peek.clickOutside()
    await api.peek.shortcutStatus()
    await api.quickHide.get()
    await api.quickHide.set(true)
    expect(ipc.invoke.mock.calls).toEqual([
      ['peek:get'],
      ['peek:inputFocus', true],
      ['peek:activity'],
      ['peek:clickOutside'],
      ['peek:shortcutStatus'],
      ['quickHide:get'],
      ['quickHide:set', true]
    ])
  })

  it('maps the settings inspector methods to their channels (Phase 11)', async () => {
    const ipc = fakeIpcRenderer()
    const api = createTaskyardApi(ipc, versions)
    await api.peek.hold(true)
    await api.peek.hold(false)
    await api.app.openDataFolder()
    await api.app.info()
    expect(ipc.invoke.mock.calls).toEqual([
      ['peek:hold', true],
      ['peek:hold', false],
      ['app:openDataFolder'],
      ['app:info']
    ])
  })

  it('maps the native-menu methods to their channels (native menus, Phase 3)', async () => {
    const ipc = fakeIpcRenderer()
    const api = createTaskyardApi(ipc, versions)
    const request = {
      kind: 'background' as const,
      displayId: 1,
      point: { x: 5, y: 6 },
      extendedVerbs: true,
      state: { iconSize: 'large' as const, gridSnap: true, quickHidden: false, toolsShown: true }
    }
    await api.shellMenu.show(request)
    await api.shellMenu.available()
    expect(ipc.invoke.mock.calls).toEqual([['shellMenu:show', request], ['shellMenu:available']])
  })

  it('returns what main returned', async () => {
    const ipc = fakeIpcRenderer()
    ipc.invoke.mockResolvedValueOnce([{ id: 1 }])

    expect(await createTaskyardApi(ipc, versions).display.list()).toEqual([{ id: 1 }])
  })

  it('delivers only the payload to event listeners, never the IPC event object', () => {
    const ipc = fakeIpcRenderer()
    const api = createTaskyardApi(ipc, versions)
    const listener = vi.fn()

    api.on('peek:changed', listener)
    ipc.dispatch('peek:changed', { peeking: true })

    expect(listener).toHaveBeenCalledExactlyOnceWith({ peeking: true })
  })

  it('returns an unsubscribe for every event', () => {
    const ipc = fakeIpcRenderer()
    const api = createTaskyardApi(ipc, versions)

    for (const event of EVENT_CHANNELS) {
      const listener = vi.fn()
      const off = api.on(event, listener)
      ipc.dispatch(event, { n: 1 })
      off()
      ipc.dispatch(event, { n: 2 })

      expect(listener).toHaveBeenCalledExactlyOnceWith({ n: 1 })
      expect(ipc.listeners.get(event)?.size).toBe(0)
    }
  })

  it('keeps two subscriptions to the same event independent', () => {
    const ipc = fakeIpcRenderer()
    const api = createTaskyardApi(ipc, versions)
    const first = vi.fn()
    const second = vi.fn()

    const offFirst = api.on('desktop:icon', first)
    api.on('desktop:icon', second)
    offFirst()
    ipc.dispatch('desktop:icon', { id: '1:2', px: 64, dataUrl: 'data:', version: 'v1' })

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })

  it('refuses to subscribe to a channel that is not a Taskyard event', () => {
    const api = createTaskyardApi(fakeIpcRenderer(), versions)
    const on = api.on as (event: string, listener: () => void) => () => void

    expect(() => on('storage:load', vi.fn())).toThrow(/unknown event "storage:load"/)
    expect(() => on('ELECTRON_BROWSER_WINDOW_ALERT', vi.fn())).toThrow(/unknown event/)
  })

  it('refuses a listener that is not a function', () => {
    const api = createTaskyardApi(fakeIpcRenderer(), versions)
    const on = api.on as (event: string, listener: unknown) => () => void

    expect(() => on('peek:changed', 'nope')).toThrow(/listener must be a function/)
  })
})
