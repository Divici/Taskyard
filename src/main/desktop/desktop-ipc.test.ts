import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { FakeIpcMain, TRUSTED_RENDERER_URL } from '../ipc/fake-ipc-main'
import { registerDesktopIpc, type DesktopIpcTarget } from './desktop-ipc'

function target(): { [K in keyof DesktopIpcTarget]: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => [{ id: '1:2' }]),
    rescan: vi.fn(async () => {}),
    open: vi.fn(async () => ({ ok: true })),
    showInFolder: vi.fn(async () => ({ ok: true })),
    rename: vi.fn(async () => ({ ok: true, path: 'C:\\D\\b.txt' })),
    trash: vi.fn(async () => ({ ok: true })),
    moveToDesktop: vi.fn(async () => ({ moves: [] })),
    undoMove: vi.fn(async () => ({ ok: true, path: 'D:\\a.txt' })),
    icons: vi.fn(() => [{ id: '1:2', px: 96, dataUrl: 'data:image/png;base64,AA' }])
  }
}

function setup(): {
  ipc: FakeIpcMain
  service: ReturnType<typeof target>
  warn: ReturnType<typeof vi.fn>
  unregister: () => void
} {
  const ipc = new FakeIpcMain()
  const service = target()
  const warn = vi.fn()
  const unregister = registerDesktopIpc(
    ipc,
    { isTrustedSender: (event) => event.senderFrame?.url === TRUSTED_RENDERER_URL, log: { warn } },
    async () => service as unknown as DesktopIpcTarget
  )
  return { ipc, service, warn, unregister }
}

describe('registerDesktopIpc', () => {
  it('registers exactly the desktop channels, and the disposer removes them', () => {
    const { ipc, unregister } = setup()

    expect([...ipc.handlers.keys()].sort()).toEqual(Object.values(IPC.desktop).sort())
    unregister()
    expect(ipc.handlers.size).toBe(0)
  })

  it('forwards each request to the service and returns its answer', async () => {
    const { ipc, service } = setup()

    await expect(ipc.invoke(IPC.desktop.list)).resolves.toEqual([{ id: '1:2' }])
    await expect(ipc.invoke(IPC.desktop.rename, '1:2', 'b.txt')).resolves.toEqual({
      ok: true,
      path: 'C:\\D\\b.txt'
    })
    await ipc.invoke(IPC.desktop.open, '1:2')
    await ipc.invoke(IPC.desktop.showInFolder, '1:2')
    await ipc.invoke(IPC.desktop.trash, '1:2')
    await ipc.invoke(IPC.desktop.moveToDesktop, ['D:\\a.txt', '\\\\nas\\s\\b.txt'])
    await ipc.invoke(IPC.desktop.undoMove, 'token-1')
    await ipc.invoke(IPC.desktop.rescan)
    await expect(ipc.invoke(IPC.desktop.icons)).resolves.toEqual([
      { id: '1:2', px: 96, dataUrl: 'data:image/png;base64,AA' }
    ])

    expect(service.rename).toHaveBeenCalledExactlyOnceWith('1:2', 'b.txt')
    expect(service.open).toHaveBeenCalledExactlyOnceWith('1:2')
    expect(service.showInFolder).toHaveBeenCalledExactlyOnceWith('1:2')
    expect(service.trash).toHaveBeenCalledExactlyOnceWith('1:2')
    expect(service.moveToDesktop).toHaveBeenCalledExactlyOnceWith([
      'D:\\a.txt',
      '\\\\nas\\s\\b.txt'
    ])
    expect(service.undoMove).toHaveBeenCalledExactlyOnceWith('token-1')
    expect(service.rescan).toHaveBeenCalledOnce()
  })

  it('rejects malformed arguments before the service sees them', async () => {
    const { ipc, service, warn } = setup()
    const bad: Array<[string, unknown[]]> = [
      [IPC.desktop.open, ['not-an-id']],
      [IPC.desktop.open, []],
      [IPC.desktop.rename, ['1:2', 42]],
      [IPC.desktop.rename, ['1:2', 'x'.repeat(300)]],
      [IPC.desktop.trash, ['1:2', 'extra']],
      [IPC.desktop.moveToDesktop, [[]]],
      [IPC.desktop.moveToDesktop, [['relative\\path.txt']]],
      [IPC.desktop.moveToDesktop, ['D:\\a.txt']],
      [IPC.desktop.moveToDesktop, [['D:\\']]],
      [IPC.desktop.moveToDesktop, [['D:\\a.txt', 'E:']]],
      [IPC.desktop.moveToDesktop, [['\\\\server\\share']]],
      [IPC.desktop.moveToDesktop, [['\\\\server\\share\\']]],
      [IPC.desktop.undoMove, ['']],
      [IPC.desktop.list, ['x']],
      [IPC.desktop.icons, [1]]
    ]

    for (const [channel, args] of bad) {
      await expect(
        ipc.invoke(channel, ...args),
        `${channel} ${JSON.stringify(args)}`
      ).rejects.toThrow(`invalid arguments for ${channel}`)
    }
    expect(warn).toHaveBeenCalledTimes(bad.length)
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled()
  })

  it('refuses every channel to a sender that is not the Taskyard renderer', async () => {
    const { ipc, service } = setup()
    const evil = { sender: { id: 9 }, senderFrame: { url: 'https://evil.example/' } }

    await expect(ipc.invokeFrom(evil, IPC.desktop.trash, '1:2')).rejects.toThrow('untrusted sender')
    expect(service.trash).not.toHaveBeenCalled()
  })
})
