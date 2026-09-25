import { z } from 'zod'
import { IPC } from '@shared/ipc'
import { FileIdSchema } from '@shared/schema'
import {
  handleTrusted,
  type IpcInvokeEventLike,
  type IpcMainLike,
  type TrustedHandlerOptions
} from '../ipc/sender-guard'
import type { Hwnd, Win32Api } from '../win32/api'

/** A drag image (Electron `NativeImage`): only emptiness matters here. */
export interface DragIcon {
  isEmpty(): boolean
}

/** What `webContents.startDrag` receives (Electron's `Item`). */
export interface DragItem<I extends DragIcon = DragIcon> {
  file: string
  files: string[]
  icon: I
}

/** What the drag-out channels need from main (injected: tests never load Electron). */
export interface DragOutDeps {
  /** The current paths of the ids that are on the desktop, in order (unknown ids skipped). */
  paths(ids: string[]): Promise<string[]>
  /** The image under the cursor during the OS drag; null when none can be made. */
  icon(ids: string[], files: string[]): Promise<DragIcon | null>
  /** `webContents.startDrag(item)` on the window that asked (Windows: a modal loop). */
  startDrag(event: IpcInvokeEventLike, item: DragItem): void
  /** Whether another app's top-level window is under the cursor (see `cursorOverOtherWindow`). */
  cursorOverOtherWindow(event: IpcInvokeEventLike): Promise<boolean> | boolean
  /**
   * Whether the primary mouse button is physically down: the OS drag needs it (Windows' drag
   * loop would otherwise drop at once, wherever the cursor is), so touch, pen and synthetic
   * input never hand over.
   */
  primaryButtonDown(): Promise<boolean> | boolean
}

/** Far above any real selection, small enough to bound the work. */
const MAX_DRAG_IDS = 1_000

const Args = {
  ids: z.tuple([z.array(FileIdSchema).min(1).max(MAX_DRAG_IDS)]),
  none: z.tuple([])
}

/**
 * Whether the top-level window under the cursor is not `own` (the desktop window asking): the
 * desktop window is at the bottom of the z-order, so another app's window covers it there and a
 * drag over it belongs to the OS. False when nothing or our own window is there, or our window is
 * unknown.
 */
export function cursorOverOtherWindow(
  api: Pick<Win32Api, 'rootWindowAtCursor'>,
  own: Hwnd | null
): boolean {
  if (own === null) return false
  const at = api.rootWindowAtCursor()
  return at !== null && at !== own
}

/**
 * Registers `desktop:startDrag` and `desktop:cursorOverOtherWindow` (Phase 8 drag-out): the
 * Taskyard renderer only (`handleTrusted`), zod-validated. The renderer has already cancelled its
 * own (dnd-kit) drag when it asks for the OS drag. Returns the disposer.
 */
export function registerDragOutIpc(
  ipc: IpcMainLike,
  trust: TrustedHandlerOptions,
  deps: DragOutDeps
): () => void {
  function handle<A extends unknown[]>(
    channel: string,
    schema: z.ZodType<A>,
    run: (event: IpcInvokeEventLike, args: A) => unknown
  ): void {
    handleTrusted(ipc, channel, trust, (event, args) => {
      const parsed = schema.safeParse(args)
      if (!parsed.success) {
        trust.log.warn(`ipc: invalid arguments for ${channel}`, z.prettifyError(parsed.error))
        throw new Error(`invalid arguments for ${channel}`)
      }
      return run(event, parsed.data)
    })
  }

  handle(IPC.dragOut.start, Args.ids, async (event, [ids]) => {
    if (!(await deps.primaryButtonDown())) return false
    const files = await deps.paths(ids)
    if (files.length === 0) return false
    const icon = await deps.icon(ids, files)
    if (icon === null || icon.isEmpty()) {
      trust.log.warn(`dnd: no icon for the drag of ${files.length} item(s); not started`)
      return false
    }
    deps.startDrag(event, { file: files[0], files, icon })
    return true
  })
  handle(
    IPC.dragOut.probe,
    Args.none,
    async (event) => (await deps.primaryButtonDown()) && deps.cursorOverOtherWindow(event)
  )

  return () => {
    for (const channel of Object.values(IPC.dragOut)) ipc.removeHandler(channel)
  }
}
