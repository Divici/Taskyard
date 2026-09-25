import { win32 } from 'node:path'
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import { FileIdSchema, type DesktopItem } from '@shared/schema'
import {
  handleTrusted,
  type IpcInvokeEventLike,
  type IpcMainLike,
  type TrustedHandlerOptions
} from '../ipc/sender-guard'
import type { FileOps } from './file-ops'
import { isVolumeOrShareRoot, MAX_NAME_LENGTH } from './file-names'

/** What the desktop channels need from the desktop service. */
export interface DesktopIpcTarget extends FileOps {
  list(): Promise<DesktopItem[]>
  rescan(): Promise<void>
}

/** Explorer drops at once; far above any real drop, small enough to bound the work. */
const MAX_DROP_PATHS = 1_000
/** Windows' extended-length limit. */
const MAX_PATH_CHARS = 32_767

const AbsolutePath = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .refine(
    (path) => win32.isAbsolute(path) && /^([a-z]:\\|\\\\)/i.test(path),
    'not an absolute path'
  )
  .refine((path) => !isVolumeOrShareRoot(path), 'a drive or share root cannot be moved')

const Args = {
  none: z.tuple([]),
  id: z.tuple([FileIdSchema]),
  rename: z.tuple([FileIdSchema, z.string().min(1).max(MAX_NAME_LENGTH)]),
  paths: z.tuple([z.array(AbsolutePath).min(1).max(MAX_DROP_PATHS)]),
  token: z.tuple([z.string().min(1).max(200)])
}

/**
 * Registers the `desktop:*` request channels: every call must come from the Taskyard renderer
 * (`handleTrusted`) and pass its zod tuple before the service sees it. `service` resolves once
 * the desktop service exists (the scan step of boot). Returns the disposer.
 */
export function registerDesktopIpc(
  ipc: IpcMainLike,
  trust: TrustedHandlerOptions,
  service: () => Promise<DesktopIpcTarget>
): () => void {
  function handle<A extends unknown[]>(
    channel: string,
    schema: z.ZodType<A>,
    run: (target: DesktopIpcTarget, args: A) => unknown
  ): void {
    handleTrusted(ipc, channel, trust, async (_event: IpcInvokeEventLike, args) => {
      const parsed = schema.safeParse(args)
      if (!parsed.success) {
        trust.log.warn(`ipc: invalid arguments for ${channel}`, z.prettifyError(parsed.error))
        throw new Error(`invalid arguments for ${channel}`)
      }
      return run(await service(), parsed.data)
    })
  }

  handle(IPC.desktop.list, Args.none, (s) => s.list())
  handle(IPC.desktop.rescan, Args.none, (s) => s.rescan())
  handle(IPC.desktop.open, Args.id, (s, [id]) => s.open(id))
  handle(IPC.desktop.showInFolder, Args.id, (s, [id]) => s.showInFolder(id))
  handle(IPC.desktop.rename, Args.rename, (s, [id, name]) => s.rename(id, name))
  handle(IPC.desktop.trash, Args.id, (s, [id]) => s.trash(id))
  handle(IPC.desktop.moveToDesktop, Args.paths, (s, [paths]) => s.moveToDesktop(paths))
  handle(IPC.desktop.undoMove, Args.token, (s, [token]) => s.undoMove(token))

  return () => {
    for (const channel of Object.values(IPC.desktop)) ipc.removeHandler(channel)
  }
}
