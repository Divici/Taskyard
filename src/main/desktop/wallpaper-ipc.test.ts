import { describe, expect, it, vi } from 'vitest'
import { IPC, type WallpaperInfo } from '@shared/ipc'
import { FakeIpcMain, TRUSTED_RENDERER_URL } from '../ipc/fake-ipc-main'
import { registerWallpaperIpc } from './wallpaper-ipc'

const INFO: WallpaperInfo = {
  displayId: 12,
  version: 3,
  url: 'taskyard://wallpaper/12?v=3',
  position: 'fit',
  color: '#000000',
  scaleFactor: 1,
  displayRectPx: { x: 2560, y: 0, width: 1920, height: 1080 },
  virtualRectPx: { x: 0, y: 0, width: 4480, height: 1440 },
  hint: null
}

function setup(): {
  ipc: FakeIpcMain
  describe: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} {
  const ipc = new FakeIpcMain()
  const describe = vi.fn((id: number) => (id === 12 ? INFO : null))
  const warn = vi.fn()
  registerWallpaperIpc(ipc, async () => ({ describe }), {
    isTrustedSender: (event) => event.senderFrame?.url === TRUSTED_RENDERER_URL,
    log: { warn }
  })
  return { ipc, describe, warn }
}

describe('registerWallpaperIpc', () => {
  it("answers wallpaper:get with that display's wallpaper, null for an unknown display", async () => {
    const { ipc } = setup()
    expect(await ipc.invoke(IPC.wallpaper.get, 12)).toEqual(INFO)
    expect(await ipc.invoke(IPC.wallpaper.get, 99)).toBeNull()
  })

  it('validates the display id before asking the service', async () => {
    const { ipc, describe } = setup()
    for (const bad of ['12', -1, 1.5, null, undefined]) {
      await expect(ipc.invoke(IPC.wallpaper.get, bad)).rejects.toThrow(/display id/)
    }
    expect(describe).not.toHaveBeenCalled()
  })

  it('refuses other senders', async () => {
    const { ipc, warn } = setup()
    await expect(
      ipc.invokeFrom(
        { sender: { id: 5 }, senderFrame: { url: 'https://x.example/' } },
        IPC.wallpaper.get,
        12
      )
    ).rejects.toThrow(/untrusted/)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
