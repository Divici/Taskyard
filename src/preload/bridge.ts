import { IPC, isEventChannel, type IpcEventName, type IpcEvents } from '@shared/ipc'
import type { TaskyardApi } from './api'

/** The slice of Electron's `ipcRenderer` the bridge uses (injectable for tests). */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

/**
 * Builds `window.taskyard`. Each method maps to one request channel; `on` accepts only the listed
 * event channels and hands listeners the payload alone — never the IPC event, which would expose
 * `sender` to the page.
 */
export function createTaskyardApi(
  ipc: IpcRendererLike,
  versions: TaskyardApi['versions']
): TaskyardApi {
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    ipc.invoke(channel, ...args) as Promise<T>

  return {
    versions: { ...versions },

    storage: {
      load: (store) => invoke(IPC.storage.load, store),
      save: (store, data) => invoke(IPC.storage.save, store, data),
      status: () => invoke(IPC.storage.status)
    },

    app: {
      quit: () => invoke(IPC.app.quit),
      openExternal: (url) => invoke(IPC.app.openExternal, url)
    },

    display: {
      get: (id) => invoke(IPC.display.get, id),
      list: () => invoke(IPC.display.list)
    },

    on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void {
      if (!isEventChannel(event)) throw new Error(`taskyard.on: unknown event "${String(event)}"`)
      if (typeof listener !== 'function')
        throw new Error('taskyard.on: listener must be a function')

      const forward = (_event: unknown, payload: unknown): void => {
        listener(payload as IpcEvents[E])
      }
      ipc.on(event, forward)
      return () => {
        ipc.removeListener(event, forward)
      }
    }
  }
}
