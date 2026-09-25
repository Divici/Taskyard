import {
  IPC,
  isEventChannel,
  SETTINGS_IPC,
  TIMER_IPC,
  type IpcEventName,
  type IpcEvents
} from '@shared/ipc'
import type { TaskyardApi } from './api'

/** The slice of Electron's `ipcRenderer` the bridge uses (injectable for tests). */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

/** Electron's `webUtils` slice: the path of a File dropped from Explorer (injectable for tests). */
export interface WebUtilsLike {
  getPathForFile(file: File): string
}

const NO_WEB_UTILS: WebUtilsLike = {
  getPathForFile: () => ''
}

/**
 * Builds `window.taskyard`. Each method maps to one request channel; `on` accepts only the listed
 * event channels and hands listeners the payload alone — never the IPC event, which would expose
 * `sender` to the page.
 */
export function createTaskyardApi(
  ipc: IpcRendererLike,
  versions: TaskyardApi['versions'],
  webUtils: WebUtilsLike = NO_WEB_UTILS
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
      openExternal: (url) => invoke(IPC.app.openExternal, url),
      openDataFolder: () => invoke(SETTINGS_IPC.openDataFolder),
      info: () => invoke(SETTINGS_IPC.info)
    },

    display: {
      get: (id) => invoke(IPC.display.get, id),
      list: () => invoke(IPC.display.list)
    },

    peek: {
      get: () => invoke(IPC.peek.get),
      inputFocus: (focused) => invoke(IPC.peek.inputFocus, focused),
      activity: () => invoke(IPC.peek.activity),
      clickOutside: () => invoke(IPC.peek.clickOutside),
      shortcutStatus: () => invoke(IPC.peek.shortcutStatus),
      hold: (on) => invoke(SETTINGS_IPC.peekHold, on)
    },

    quickHide: {
      get: () => invoke(IPC.quickHide.get),
      set: (hidden) => invoke(IPC.quickHide.set, hidden)
    },

    desktop: {
      list: () => invoke(IPC.desktop.list),
      open: (id) => invoke(IPC.desktop.open, id),
      showInFolder: (id) => invoke(IPC.desktop.showInFolder, id),
      rename: (id, newName) => invoke(IPC.desktop.rename, id, newName),
      trash: (id) => invoke(IPC.desktop.trash, id),
      moveToDesktop: (paths) => invoke(IPC.desktop.moveToDesktop, paths),
      undoMove: (token) => invoke(IPC.desktop.undoMove, token),
      rescan: () => invoke(IPC.desktop.rescan),
      icons: () => invoke(IPC.desktop.icons),
      startDrag: (ids) => invoke(IPC.dragOut.start, ids),
      cursorOverOtherWindow: () => invoke(IPC.dragOut.probe),
      pathForFile: (file) => webUtils.getPathForFile(file)
    },

    theme: {
      get: () => invoke(IPC.theme.get)
    },

    wallpaper: {
      get: (displayId) => invoke(IPC.wallpaper.get, displayId)
    },

    timer: {
      notify: (request) => invoke(TIMER_IPC.notify, request)
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
