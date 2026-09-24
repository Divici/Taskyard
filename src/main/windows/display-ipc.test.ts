import { describe, expect, it, vi } from 'vitest'
import {
  DISPLAY_CHANNELS,
  registerDisplayIpc,
  toDisplayInfo,
  type DisplayInfo,
  type IpcMainLike
} from './display-ipc'

const PRIMARY: DisplayInfo = {
  id: 2450156880,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1392 },
  scaleFactor: 1.25
}

type Handler = (event: unknown, ...args: unknown[]) => unknown

function fakeIpcMain(): IpcMainLike & { invoke(channel: string, ...args: unknown[]): unknown } {
  const handlers = new Map<string, Handler>()
  return {
    handle: vi.fn((channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`second handler for ${channel}`)
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    }),
    invoke(channel, ...args) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`no handler for ${channel}`)
      return handler({}, ...args)
    }
  }
}

describe('DISPLAY_CHANNELS', () => {
  it('names the display and peek channels', () => {
    expect(DISPLAY_CHANNELS).toEqual({
      get: 'display:get',
      list: 'display:list',
      changed: 'display:changed',
      peekChanged: 'peek:changed'
    })
  })
})

describe('toDisplayInfo', () => {
  it('copies id, bounds, workArea and scaleFactor into plain objects', () => {
    const display = { ...PRIMARY, rotation: 0, internal: false, label: 'DELL' }

    const info = toDisplayInfo(display)

    expect(info).toEqual(PRIMARY)
    expect(info.bounds).not.toBe(display.bounds)
  })
})

describe('registerDisplayIpc', () => {
  const source = {
    getDisplay: (id: number) => (id === PRIMARY.id ? PRIMARY : null),
    listDisplays: () => [PRIMARY]
  }

  it('answers display:get with bounds, workArea and scaleFactor', () => {
    const ipcMain = fakeIpcMain()
    registerDisplayIpc(ipcMain, source)

    expect(ipcMain.invoke('display:get', PRIMARY.id)).toEqual(PRIMARY)
    expect(ipcMain.invoke('display:get', 12345)).toBeNull()
  })

  it('answers display:list with every display', () => {
    const ipcMain = fakeIpcMain()
    registerDisplayIpc(ipcMain, source)

    expect(ipcMain.invoke('display:list')).toEqual([PRIMARY])
  })

  it.each(['1', 1.5, -1, Number.NaN, undefined, null])('rejects display id %j', (id) => {
    const ipcMain = fakeIpcMain()
    registerDisplayIpc(ipcMain, source)

    expect(() => ipcMain.invoke('display:get', id)).toThrow(
      'display:get expects a non-negative integer display id'
    )
  })

  it('returns an unregister function that removes both handlers', () => {
    const ipcMain = fakeIpcMain()

    const unregister = registerDisplayIpc(ipcMain, source)
    unregister()

    expect(ipcMain.removeHandler).toHaveBeenCalledWith('display:get')
    expect(ipcMain.removeHandler).toHaveBeenCalledWith('display:list')
    expect(() => ipcMain.invoke('display:list')).toThrow('no handler for display:list')
  })
})
