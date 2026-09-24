// Test support: an in-memory ipcMain, so handler tests never load Electron.
import type { IpcInvokeEventLike, IpcMainLike } from './handlers'

type Listener = (event: IpcInvokeEventLike, ...args: unknown[]) => unknown

export const TRUSTED_RENDERER_URL = 'file:///C:/app/out/renderer/index.html'

/** An invoke event from the Taskyard renderer page in the window with this webContents id. */
export function trustedEvent(senderId = 1): IpcInvokeEventLike {
  return { sender: { id: senderId }, senderFrame: { url: TRUSTED_RENDERER_URL } }
}

export class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, Listener>()

  handle(channel: string, listener: Listener): void {
    if (this.handlers.has(channel)) throw new Error(`second handler for ${channel}`)
    this.handlers.set(channel, listener)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  /** Mirrors ipcRenderer.invoke: the handler's return value or thrown error becomes a promise. */
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return this.invokeFrom(trustedEvent(), channel, ...args)
  }

  /**
   * Runs the handler synchronously (main handles requests in arrival order) and returns its
   * result as a promise, as Electron delivers it.
   */
  invokeFrom(event: IpcInvokeEventLike, channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) return Promise.reject(new Error(`No handler registered for '${channel}'`))
    try {
      return Promise.resolve(handler(event, ...args))
    } catch (error) {
      return Promise.reject(error)
    }
  }
}
