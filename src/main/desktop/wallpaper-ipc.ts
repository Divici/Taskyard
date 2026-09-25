import { IPC, type WallpaperInfo } from '@shared/ipc'
import { handleTrusted, type IpcMainLike, type TrustedHandlerOptions } from '../ipc/sender-guard'

/** What the handler needs from the wallpaper service. */
export interface WallpaperSource {
  describe(displayId: number): WallpaperInfo | null
}

function assertDisplayId(id: unknown): asserts id is number {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
    throw new TypeError(`${IPC.wallpaper.get} expects a non-negative integer display id`)
  }
}

/**
 * `wallpaper:get` for the Taskyard renderer only. The service exists once Win32 and the screen
 * are ready, so requests made earlier wait for it.
 */
export function registerWallpaperIpc(
  ipcMain: IpcMainLike,
  source: () => Promise<WallpaperSource>,
  trust: TrustedHandlerOptions
): () => void {
  handleTrusted(ipcMain, IPC.wallpaper.get, trust, async (_event, [displayId]) => {
    assertDisplayId(displayId)
    return (await source()).describe(displayId)
  })
  return () => ipcMain.removeHandler(IPC.wallpaper.get)
}
