import { z } from 'zod'
import { IPC, type QuickHideState } from '@shared/ipc'
import { handleTrusted, type IpcMainLike, type TrustedHandlerOptions } from '../ipc/sender-guard'

// Quick-hide (Phase 9): a double-click on the empty desktop hides the icons and groups on every
// display together, as Fences does. Main holds the one flag in memory — never in a file, so every
// launch starts with the desktop shown — and relays changes to every window.

export interface QuickHideDeps {
  emit: (event: 'quickHide:changed', payload: QuickHideState) => unknown
}

export interface QuickHide {
  readonly hidden: boolean
  /** Sets the flag; every window (the caller too) hears `quickHide:changed` when it changes. */
  set(hidden: boolean): void
}

export function createQuickHide(deps: QuickHideDeps): QuickHide {
  let hidden = false
  return {
    get hidden() {
      return hidden
    },
    set(next) {
      if (next === hidden) return
      hidden = next
      deps.emit('quickHide:changed', { hidden })
    }
  }
}

const Args = { none: z.tuple([]), hidden: z.tuple([z.boolean()]) }

/** `quickHide:get` / `quickHide:set` for the Taskyard renderer only. Returns the remover. */
export function registerQuickHideIpc(
  ipc: IpcMainLike,
  trust: TrustedHandlerOptions,
  quickHide: QuickHide
): () => void {
  const parse = <T>(channel: string, schema: z.ZodType<T>, args: unknown[]): T => {
    const result = schema.safeParse(args)
    if (result.success) return result.data
    trust.log.warn(`ipc: invalid arguments for ${channel}`, z.prettifyError(result.error))
    throw new Error(`invalid arguments for ${channel}`)
  }
  handleTrusted(ipc, IPC.quickHide.get, trust, (_event, args) => {
    parse(IPC.quickHide.get, Args.none, args)
    return quickHide.hidden
  })
  handleTrusted(ipc, IPC.quickHide.set, trust, (_event, args) => {
    const [hidden] = parse(IPC.quickHide.set, Args.hidden, args)
    quickHide.set(hidden)
  })
  return () => {
    ipc.removeHandler(IPC.quickHide.get)
    ipc.removeHandler(IPC.quickHide.set)
  }
}
