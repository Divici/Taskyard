import { describe, expect, it, vi } from 'vitest'
import { IPC, type DisplayInfo } from '@shared/ipc'
import { FakeIpcMain, TRUSTED_RENDERER_URL } from '../ipc/fake-ipc-main'
import { registerDisplayIpc, toDisplayInfo } from './display-ipc'

const PRIMARY: DisplayInfo = {
  id: 2450156880,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1392 },
  scaleFactor: 1.25
}

const source = {
  getDisplay: (id: number) => (id === PRIMARY.id ? PRIMARY : null),
  listDisplays: () => [PRIMARY]
}

function setup(): { ipc: FakeIpcMain; warn: ReturnType<typeof vi.fn>; unregister: () => void } {
  const ipc = new FakeIpcMain()
  const warn = vi.fn()
  const unregister = registerDisplayIpc(ipc, source, {
    isTrustedSender: (event) => event.senderFrame?.url === TRUSTED_RENDERER_URL,
    log: { warn }
  })
  return { ipc, warn, unregister }
}

describe('toDisplayInfo', () => {
  it('copies id, bounds, workArea and scaleFactor into plain objects', () => {
    const display = { ...PRIMARY, rotation: 0, internal: false, label: 'DELL' }

    const info = toDisplayInfo(display)

    expect(info).toEqual(PRIMARY)
    expect(info.bounds).not.toBe(display.bounds)
  })
})

describe('registerDisplayIpc', () => {
  it('registers exactly the shared display channels from src/shared/ipc.ts', () => {
    const { ipc } = setup()

    expect([...ipc.handlers.keys()]).toEqual([IPC.display.get, IPC.display.list])
  })

  it('answers display:get with bounds, workArea and scaleFactor, and null for an unknown id', async () => {
    const { ipc } = setup()

    await expect(ipc.invoke(IPC.display.get, PRIMARY.id)).resolves.toEqual(PRIMARY)
    await expect(ipc.invoke(IPC.display.get, 12345)).resolves.toBeNull()
  })

  it('answers display:list with every display', async () => {
    const { ipc } = setup()

    await expect(ipc.invoke(IPC.display.list)).resolves.toEqual([PRIMARY])
  })

  it.each(['1', 1.5, -1, Number.NaN, undefined, null])('rejects display id %j', async (id) => {
    const { ipc } = setup()

    await expect(ipc.invoke(IPC.display.get, id)).rejects.toThrow(
      'display:get expects a non-negative integer display id'
    )
  })

  it('refuses both channels to any sender that is not the Taskyard renderer', async () => {
    const { ipc, warn } = setup()
    const stranger = { sender: { id: 9 }, senderFrame: { url: 'https://evil.example/' } }

    await expect(ipc.invokeFrom(stranger, IPC.display.get, PRIMARY.id)).rejects.toThrow(
      'untrusted sender for display:get'
    )
    await expect(ipc.invokeFrom(stranger, IPC.display.list)).rejects.toThrow(
      'untrusted sender for display:list'
    )
    expect(warn).toHaveBeenCalledWith('ipc: rejected display:get from https://evil.example/')
  })

  it('returns an unregister function that removes both handlers', async () => {
    const { ipc, unregister } = setup()

    unregister()

    expect(ipc.handlers.size).toBe(0)
    await expect(ipc.invoke(IPC.display.list)).rejects.toThrow(
      "No handler registered for 'display:list'"
    )
  })
})
