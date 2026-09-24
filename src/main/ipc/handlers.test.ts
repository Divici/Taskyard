import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, emptyLayout, emptyTasks, newDisplayLayout } from '@shared/defaults'
import { createStorage, type Storage } from '../storage/stores'
import { createEventEmitter, type WebContentsLike } from './events'
import { FakeIpcMain, trustedEvent, TRUSTED_RENDERER_URL } from './fake-ipc-main'
import { HANDLED_CHANNELS, registerIpcHandlers, type HandlerDeps } from './handlers'

function renderer(id: number): WebContentsLike & { send: ReturnType<typeof vi.fn> } {
  return { id, isDestroyed: () => false, send: vi.fn() }
}

let dir: string
let storage: Storage
let ipc: FakeIpcMain
let windows: Array<ReturnType<typeof renderer>>
let deps: HandlerDeps & {
  openExternal: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
  log: { warn: ReturnType<typeof vi.fn> }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'taskyard-ipc-'))
  windows = [renderer(7), renderer(8)]
  // Wired exactly as src/main/index.ts does: every accepted save is broadcast to every window.
  const events = createEventEmitter(() => windows, { warn: vi.fn() })
  storage = createStorage({
    dir,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onChange: (change) => events.emit('storage:changed', change)
  })
  await storage.loadAll()
  ipc = new FakeIpcMain()
  deps = {
    storage,
    isTrustedSender: (event) => event.senderFrame?.url === TRUSTED_RENDERER_URL,
    openExternal: vi.fn(async () => {}),
    quit: vi.fn(),
    log: { warn: vi.fn() }
  }
  registerIpcHandlers(ipc, deps)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('registerIpcHandlers', () => {
  it('handles the storage and app channels; display channels belong to the window manager', () => {
    expect([...ipc.handlers.keys()].sort()).toEqual(
      ['app:openExternal', 'app:quit', 'storage:load', 'storage:save', 'storage:status'].sort()
    )
    expect([...HANDLED_CHANNELS].sort()).toEqual([...ipc.handlers.keys()].sort())
  })

  it('returns a disposer that removes every handler', () => {
    const fresh = new FakeIpcMain()
    const dispose = registerIpcHandlers(fresh, deps)

    dispose()

    expect(fresh.handlers.size).toBe(0)
  })
})

describe('storage:load', () => {
  it('returns the loaded store with its revision', async () => {
    expect(await ipc.invoke('storage:load', 'settings')).toEqual({
      revision: 1,
      data: defaultSettings()
    })
    expect(await ipc.invoke('storage:load', 'layout')).toEqual({ revision: 1, data: emptyLayout() })
  })

  it.each([['ops'], ['../settings'], [42], [undefined]])('rejects store name %j', async (name) => {
    await expect(ipc.invoke('storage:load', name)).rejects.toThrow(
      /invalid arguments for storage:load/
    )
    expect(deps.log.warn).toHaveBeenCalled()
  })
})

describe('storage:save', () => {
  it('accepts a save based on the current revision and replies with the new revision', async () => {
    const next = { ...defaultSettings(), theme: 'dark' as const }

    const result = await ipc.invokeFrom(trustedEvent(7), 'storage:save', 'settings', {
      baseRevision: 1,
      data: next
    })

    expect(result).toEqual({ ok: true, revision: 2 })
    expect(storage.settings.snapshot()).toEqual({ revision: 2, data: next })
    expect(storage.settings.hasPendingWrite()).toBe(true)
  })

  it('broadcasts an accepted save to every window, the sender included', async () => {
    const next = { ...defaultSettings(), accent: 'purple' as const }

    await ipc.invokeFrom(trustedEvent(7), 'storage:save', 'settings', {
      baseRevision: 1,
      data: next
    })

    for (const window of windows) {
      expect(window.send).toHaveBeenCalledExactlyOnceWith('storage:changed', {
        store: 'settings',
        revision: 2,
        data: next
      })
    }
  })

  it('still replies ok when broadcasting to one window fails, and the others get the event', async () => {
    windows[0].send.mockImplementation(() => {
      throw new Error('render frame disposed')
    })
    const next = { ...defaultSettings(), glow: false }

    const result = await ipc.invokeFrom(trustedEvent(8), 'storage:save', 'settings', {
      baseRevision: 1,
      data: next
    })

    expect(result).toEqual({ ok: true, revision: 2 })
    expect(windows[1].send).toHaveBeenCalledExactlyOnceWith('storage:changed', {
      store: 'settings',
      revision: 2,
      data: next
    })
  })

  it('rejects a save built on an old revision with main’s current revision and data', async () => {
    const first = { ...defaultSettings(), accent: 'blue' as const }
    await ipc.invokeFrom(trustedEvent(7), 'storage:save', 'settings', {
      baseRevision: 1,
      data: first
    })

    const result = await ipc.invokeFrom(trustedEvent(8), 'storage:save', 'settings', {
      baseRevision: 1,
      data: { ...defaultSettings(), accent: 'white' }
    })

    expect(result).toEqual({ ok: false, reason: 'stale', revision: 2, data: first })
    expect(storage.settings.get()).toEqual(first)
    expect(windows[0].send).toHaveBeenCalledOnce()
  })

  it('refuses to save a read-only store and does not broadcast', async () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 4 }))
    await storage.tasks.load()

    const result = await ipc.invoke('storage:save', 'tasks', {
      baseRevision: 1,
      data: emptyTasks()
    })

    expect(result).toEqual({ ok: false, reason: 'read-only' })
    expect(windows[0].send).not.toHaveBeenCalled()
  })

  it('rejects unknown keys at any depth', async () => {
    const display = { ...newDisplayLayout(1, { x: 0, y: 0, width: 10, height: 10 }), color: 'red' }

    await expect(
      ipc.invoke('storage:save', 'layout', {
        baseRevision: 1,
        data: { ...emptyLayout(), displays: [display] }
      })
    ).rejects.toThrow(/invalid arguments for storage:save/)
    await expect(
      ipc.invoke('storage:save', 'settings', {
        baseRevision: 1,
        data: { ...defaultSettings(), injected: '<script>' }
      })
    ).rejects.toThrow(/invalid arguments for storage:save/)
    expect(storage.settings.get()).not.toHaveProperty('injected')
  })

  it('rejects a partial file instead of silently filling it with defaults', async () => {
    const withoutDisplays: Partial<ReturnType<typeof emptyLayout>> = emptyLayout()
    delete withoutDisplays.displays
    const display: Partial<ReturnType<typeof newDisplayLayout>> = newDisplayLayout(1, {
      x: 0,
      y: 0,
      width: 10,
      height: 10
    })
    delete display.tools

    for (const data of [
      withoutDisplays,
      { version: 1 },
      { ...emptyLayout(), displays: [display] }
    ]) {
      await expect(ipc.invoke('storage:save', 'layout', { baseRevision: 1, data })).rejects.toThrow(
        /invalid arguments for storage:save/
      )
    }
    expect(deps.log.warn).toHaveBeenCalledWith(
      'ipc: invalid arguments for storage:save',
      'displays.0.tools: missing (the file would silently take a default)'
    )
    expect(storage.layout.snapshot()).toEqual({ revision: 1, data: emptyLayout() })
  })

  it('rejects data that does not match the store schema, and a malformed request', async () => {
    await expect(
      ipc.invoke('storage:save', 'settings', {
        baseRevision: 1,
        data: { ...defaultSettings(), glassOpacity: 900 }
      })
    ).rejects.toThrow(/invalid arguments for storage:save/)
    await expect(
      ipc.invoke('storage:save', 'layout', { baseRevision: 1, data: defaultSettings() })
    ).rejects.toThrow(/invalid arguments/)
    await expect(ipc.invoke('storage:save', 'settings', defaultSettings())).rejects.toThrow(
      /invalid arguments/
    )
    await expect(
      ipc.invoke('storage:save', 'settings', { baseRevision: -1, data: defaultSettings() })
    ).rejects.toThrow(/invalid arguments/)
    expect(storage.settings.get()).toEqual(defaultSettings())
    expect(windows[0].send).not.toHaveBeenCalled()
  })
})

describe('storage:status', () => {
  it('returns recoveries and read-only files', async () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 4 }))
    await storage.tasks.load()

    expect(await ipc.invoke('storage:status')).toEqual({
      readOnly: [{ store: 'tasks', reason: 'future-version', version: 4 }],
      recovered: []
    })
  })
})

describe('app:openExternal', () => {
  it.each([
    ['https://github.com/taskyard', 'https://github.com/taskyard'],
    ['ms-settings:display', 'ms-settings:display'],
    ['ms-settings:personalization-background', 'ms-settings:personalization-background'],
    ['HTTPS://Example.com/a b', 'https://example.com/a%20b']
  ])('opens allowed URL %j as %j', async (url, opened) => {
    await ipc.invoke('app:openExternal', url)

    expect(deps.openExternal).toHaveBeenCalledExactlyOnceWith(opened)
  })

  it.each([
    ['http://example.com'],
    ['file:///C:/Windows/System32/cmd.exe'],
    ['javascript:alert(1)'],
    ['ms-settingsx:display'],
    ['C:\\Windows\\notepad.exe'],
    ['not a url'],
    [`https://example.com/${'a'.repeat(2100)}`],
    [42],
    [undefined]
  ])('refuses %j in the main process', async (url) => {
    await expect(ipc.invoke('app:openExternal', url)).rejects.toThrow(
      /invalid arguments for app:openExternal/
    )
    expect(deps.openExternal).not.toHaveBeenCalled()
  })
})

describe('app:quit', () => {
  it('asks the app to quit', async () => {
    await ipc.invoke('app:quit')

    expect(deps.quit).toHaveBeenCalledOnce()
  })
})

describe('sender validation', () => {
  it.each([...HANDLED_CHANNELS])(
    '%s rejects a frame that is not the Taskyard renderer',
    async (channel) => {
      const foreign = { sender: { id: 3 }, senderFrame: { url: 'https://evil.example/' } }

      await expect(ipc.invokeFrom(foreign, channel, 'settings')).rejects.toThrow(/untrusted sender/)
      await expect(
        ipc.invokeFrom({ sender: { id: 3 }, senderFrame: null }, channel, 'settings')
      ).rejects.toThrow(/untrusted sender/)
      expect(deps.quit).not.toHaveBeenCalled()
      expect(deps.openExternal).not.toHaveBeenCalled()
    }
  )
})
