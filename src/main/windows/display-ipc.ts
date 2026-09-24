import { IPC, type DisplayInfo } from '@shared/ipc'
import type { Rect } from '@shared/schema'
import { handleTrusted, type IpcMainLike, type TrustedHandlerOptions } from '../ipc/sender-guard'

// Main-process side of the display channels. Every channel name and payload type comes from
// src/shared/ipc.ts (`IPC.display`, and the `display:changed` / `peek:changed` events).

/** Where display answers come from (the desktop window manager). */
export interface DisplaySource {
  getDisplay(id: number): DisplayInfo | null
  listDisplays(): DisplayInfo[]
}

const rect = ({ x, y, width, height }: Rect): Rect => ({ x, y, width, height })

/** A structured-clone-safe copy of the fields renderers need from an Electron `Display`. */
export function toDisplayInfo(display: DisplayInfo): DisplayInfo {
  return {
    id: display.id,
    bounds: rect(display.bounds),
    workArea: rect(display.workArea),
    scaleFactor: display.scaleFactor
  }
}

function assertDisplayId(id: unknown): asserts id is number {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
    throw new TypeError(`${IPC.display.get} expects a non-negative integer display id`)
  }
}

/**
 * Handles `display:get` and `display:list` for the Taskyard renderer only (the same sender check
 * as every other request channel). Returns a function that removes both handlers.
 */
export function registerDisplayIpc(
  ipcMain: IpcMainLike,
  source: DisplaySource,
  trust: TrustedHandlerOptions
): () => void {
  handleTrusted(ipcMain, IPC.display.get, trust, (_event, [id]) => {
    assertDisplayId(id)
    return source.getDisplay(id)
  })
  handleTrusted(ipcMain, IPC.display.list, trust, () => source.listDisplays())
  return () => {
    ipcMain.removeHandler(IPC.display.get)
    ipcMain.removeHandler(IPC.display.list)
  }
}
