import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SenderFrameEvent {
  senderFrame: { url: string } | null
}

export interface SenderGuardOptions {
  /** Absolute path of the built renderer page (`out/renderer/index.html`). */
  rendererFile: string
  /** The electron-vite dev server URL; trusted by origin in development only. */
  devServerUrl?: string
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * Electron security checklist, "validate the sender of all IPC messages": only frames showing the
 * Taskyard renderer may call main. Query and hash are ignored (windows add `?displayId=`); the
 * path compares case-insensitively, as NTFS does.
 */
export function createSenderGuard(
  options: SenderGuardOptions
): (event: SenderFrameEvent) => boolean {
  const rendererPath = resolve(options.rendererFile).toUpperCase()
  const devOrigin = options.devServerUrl ? parse(options.devServerUrl)?.origin : undefined

  return (event) => {
    const url = event.senderFrame ? parse(event.senderFrame.url) : null
    if (!url) return false
    if (devOrigin && url.origin === devOrigin) return true
    if (url.protocol !== 'file:') return false
    try {
      return resolve(fileURLToPath(url)).toUpperCase() === rendererPath
    } catch {
      return false
    }
  }
}

/** The fields of Electron's `IpcMainInvokeEvent` the handlers read. */
export interface IpcInvokeEventLike extends SenderFrameEvent {
  sender: { id: number }
}

/** The slice of Electron's `ipcMain` used by the handlers (injectable: tests never load Electron). */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcInvokeEventLike, ...args: unknown[]) => unknown
  ): void
  removeHandler(channel: string): void
}

export interface TrustedHandlerOptions {
  isTrustedSender: (event: IpcInvokeEventLike) => boolean
  log: { warn(message: string, ...details: unknown[]): void }
}

/**
 * `ipcMain.handle` for the Taskyard renderer only: any other sender is logged and refused before
 * `handler` runs. Every request channel — storage, app and display — is registered through this.
 */
export function handleTrusted(
  ipc: IpcMainLike,
  channel: string,
  { isTrustedSender, log }: TrustedHandlerOptions,
  handler: (event: IpcInvokeEventLike, args: unknown[]) => unknown
): void {
  ipc.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      log.warn(`ipc: rejected ${channel} from ${event.senderFrame?.url ?? 'a closed frame'}`)
      throw new Error(`untrusted sender for ${channel}`)
    }
    return handler(event, args)
  })
}
