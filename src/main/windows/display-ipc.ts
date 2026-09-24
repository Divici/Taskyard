/**
 * Main-process side of the display channels. The channel strings live here, in one object, so
 * they can be repointed at `src/shared/ipc.ts` (which owns every channel name) when merged.
 */
export const DISPLAY_CHANNELS = {
  /** invoke(id) → DisplayInfo | null */
  get: 'display:get',
  /** invoke() → DisplayInfo[] */
  list: 'display:list',
  /** main → renderer: the receiving window's own DisplayInfo, re-sent on any display change */
  changed: 'display:changed',
  /** main → renderer: PeekChangedPayload whenever Peek turns on or off */
  peekChanged: 'peek:changed'
} as const

export interface DisplayRect {
  x: number
  y: number
  width: number
  height: number
}

/** One monitor as a renderer sees it (DIP coordinates, like Electron's `Display`). */
export interface DisplayInfo {
  id: number
  bounds: DisplayRect
  workArea: DisplayRect
  scaleFactor: number
}

export interface PeekChangedPayload {
  peeking: boolean
}

/** Where display answers come from (the desktop window manager). */
export interface DisplaySource {
  getDisplay(id: number): DisplayInfo | null
  listDisplays(): DisplayInfo[]
}

/** The slice of Electron's `ipcMain` used here (injectable for tests). */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

const rect = ({ x, y, width, height }: DisplayRect): DisplayRect => ({ x, y, width, height })

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
    throw new TypeError(`${DISPLAY_CHANNELS.get} expects a non-negative integer display id`)
  }
}

/** Handles `display:get` and `display:list`. Returns a function that removes both handlers. */
export function registerDisplayIpc(ipcMain: IpcMainLike, source: DisplaySource): () => void {
  ipcMain.handle(DISPLAY_CHANNELS.get, (_event, id) => {
    assertDisplayId(id)
    return source.getDisplay(id)
  })
  ipcMain.handle(DISPLAY_CHANNELS.list, () => source.listDisplays())
  return () => {
    ipcMain.removeHandler(DISPLAY_CHANNELS.get)
    ipcMain.removeHandler(DISPLAY_CHANNELS.list)
  }
}
