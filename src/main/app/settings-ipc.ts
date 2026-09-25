import { z } from 'zod'
import { SETTINGS_IPC, type AppInfo } from '@shared/ipc'
import { handleTrusted, type IpcMainLike, type TrustedHandlerOptions } from '../ipc/sender-guard'
import type { PeekHold, PeekOptions } from '../windows/desktop-window-manager'

// The settings inspector's requests (Phase 11): holding a Peek while it is open (Assumption 11:
// opening it raises Taskyard over other apps, and the idle timer must not hide it mid-edit),
// opening the data folder, and About's facts. Every setting itself is saved through the settings
// store; main follows those saves (shortcut, autostart, tray) in index.ts.

/** What the inspector needs of the window manager. */
export interface PeekHoldTarget {
  peek(on: boolean, options?: PeekOptions): void
  releaseHold(hold: PeekHold): void
}

export interface SettingsIpcDeps {
  /** The window manager, or null before the desktop windows exist. */
  peek: () => PeekHoldTarget | null
  /** `shell.openPath`: '' on success, else Windows' error message. */
  openPath: (path: string) => Promise<string>
  dataDir: string
  info: Omit<AppInfo, 'dataDir'>
  log: { warn(message: string, ...details: unknown[]): void }
}

const Args = { none: z.tuple([]), on: z.tuple([z.boolean()]) }

/** Registers the Phase 11 channels for the Taskyard renderer only. Returns the remover. */
export function registerSettingsIpc(
  ipc: IpcMainLike,
  trust: TrustedHandlerOptions,
  deps: SettingsIpcDeps
): () => void {
  const parse = <T>(channel: string, schema: z.ZodType<T>, args: unknown[]): T => {
    const result = schema.safeParse(args)
    if (result.success) return result.data
    trust.log.warn(`ipc: invalid arguments for ${channel}`, z.prettifyError(result.error))
    throw new Error(`invalid arguments for ${channel}`)
  }

  handleTrusted(ipc, SETTINGS_IPC.peekHold, trust, (_event, args) => {
    const [on] = parse(SETTINGS_IPC.peekHold, Args.on, args)
    const target = deps.peek()
    if (!target) return
    if (on) target.peek(true, { hold: 'inspector' })
    else target.releaseHold('inspector')
  })

  handleTrusted(ipc, SETTINGS_IPC.openDataFolder, trust, async (_event, args) => {
    parse(SETTINGS_IPC.openDataFolder, Args.none, args)
    const error = await deps.openPath(deps.dataDir)
    if (error === '') return true
    deps.log.warn(`settings: could not open the data folder ${deps.dataDir}`, error)
    return false
  })

  handleTrusted(ipc, SETTINGS_IPC.info, trust, (_event, args): AppInfo => {
    parse(SETTINGS_IPC.info, Args.none, args)
    return { ...deps.info, dataDir: deps.dataDir }
  })

  return () => {
    for (const channel of Object.values(SETTINGS_IPC)) ipc.removeHandler(channel)
  }
}
