import type { ShellMenuApi, ShowMenuOutcome } from '../win32/shell-menu-api'
import { parseHelperRequest, type HelperMessage, type HelperRequest } from './protocol'

/**
 * The shell-menu helper's logic, apart from the utility-process glue in helper.ts so it runs
 * headless against the fake api. One request at a time: `show` blocks inside TrackPopupMenuEx
 * (the helper's JS thread is the menu's thread), so requests are naturally serial.
 */

/** Pump interval while a request is recent (async verbs, dialogs on the helper thread). */
export const PUMP_BUSY_MS = 16
/** How long after a request the fast pump keeps going. */
export const PUMP_BUSY_WINDOW_MS = 10_000
/** Pump interval when idle: stray messages (e.g. broadcasts) wait at most this long. */
export const PUMP_IDLE_MS = 250

/**
 * The helper's warm-up: builds (never shows) the Desktop background menu so its handlers are
 * loaded before the first right-click. Read only: no clipboard, no drop target, no invoke.
 */
export function warmUpShellMenu(api: ShellMenuApi): void {
  api.enumerate({ kind: 'desktop-background' }, { extendedVerbs: false })
}

export interface HelperCoreDeps {
  api: ShellMenuApi
  post(message: HelperMessage): void
  /** A `shutdown` request (runHelper: dispose the api, then exit). */
  onShutdown?(): void
}

function messageOf(error: unknown): string {
  if (error instanceof Error)
    return error.name === 'Error' ? error.message : `${error.name}: ${error.message}`
  return String(error)
}

function requestIdOf(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  const id = (raw as { id?: unknown }).id
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null
}

export function createHelperCore({ api, post, onShutdown }: HelperCoreDeps): {
  handle(raw: unknown): void
} {
  const run = (request: HelperRequest): void => {
    switch (request.type) {
      case 'enumerate': {
        const items = api.enumerate(request.target, {
          extendedVerbs: request.extendedVerbs,
          source: request.source,
          pasteState: request.pasteState
        })
        post({ type: 'result', id: request.id, result: { kind: 'enumerate', items } })
        return
      }
      case 'show': {
        const { id } = request
        let shown = false
        let outcome: ShowMenuOutcome
        try {
          // The request is a ShowMenuRequest plus its envelope (type, id), which the api ignores.
          outcome = api.show(request, {
            onShowing: ({ ownerHwnd }) => {
              shown = true
              post({ type: 'showing', id, ownerHwnd: String(ownerHwnd) })
            }
          })
        } catch (error) {
          // Before the menu showed, main may fall back to its own menu (an error). After, the user
          // already used this one: never a rejection, always an outcome.
          if (!shown) throw error
          outcome = {
            kind: 'invoke-failed',
            verb: null,
            label: '',
            path: [],
            message: messageOf(error)
          }
        }
        post({ type: 'result', id, result: { kind: 'show', outcome } })
        return
      }
      case 'invoke':
        api.invokeVerb(request.target, request.verb)
        post({ type: 'result', id: request.id, result: { kind: 'invoke' } })
        return
      case 'shutdown':
        onShutdown?.()
        return
    }
  }

  return {
    handle(raw) {
      let request: HelperRequest
      try {
        request = parseHelperRequest(raw)
      } catch (error) {
        const message = `invalid request: ${messageOf(error)}`
        const id = requestIdOf(raw)
        post(id === null ? { type: 'crash', message } : { type: 'error', id, message })
        return
      }
      try {
        run(request)
      } catch (error) {
        if (request.type === 'shutdown') post({ type: 'crash', message: messageOf(error) })
        else post({ type: 'error', id: request.id, message: messageOf(error) })
      }
    }
  }
}

/** `process.parentPort` in a utility process: messages arrive as `{ data }` events. */
export interface HelperPort {
  postMessage(message: HelperMessage): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
}

export interface HelperProcess {
  readonly pid: number
  exit(code: number): void
  on(event: 'exit', listener: () => void): unknown
  on(
    event: 'uncaughtException' | 'unhandledRejection',
    listener: (reason: unknown) => void
  ): unknown
}

export interface HelperLog {
  warn(message: string, ...details: unknown[]): void
}

export interface RunHelperDeps {
  port: HelperPort
  process: HelperProcess
  /**
   * Loads koffi and builds the real api (its warnings go to main's log); a throw here means the
   * helper cannot work at all.
   */
  createApi(log: HelperLog): Promise<ShellMenuApi>
  /**
   * Runs once right after `ready` (read-only: builds a menu, shows nothing). The first menu a
   * process builds loads every handler DLL (~500 ms here, and late handlers such as Open in
   * Terminal missed it); afterwards the same menu builds in ~40 ms, complete.
   */
  warmUp?(api: ShellMenuApi): void
}

/**
 * The helper's life: report uncaught errors (and keep running), build the api, then say `ready`
 * with the pid main must grant the foreground to — or `fatal` when the api cannot be built.
 */
export async function runHelper({
  port,
  process,
  createApi,
  warmUp
}: RunHelperDeps): Promise<void> {
  const post = (message: HelperMessage): void => {
    try {
      port.postMessage(message)
    } catch {
      // The port is gone (main is quitting); nothing is listening any more.
    }
  }
  const report = (reason: unknown): void => post({ type: 'crash', message: messageOf(reason) })
  process.on('uncaughtException', report)
  process.on('unhandledRejection', report)

  const log: HelperLog = {
    warn: (message, ...details) =>
      post({ type: 'warn', message: [message, ...details.map(messageOf)].join(': ') })
  }

  let api: ShellMenuApi
  try {
    api = await createApi(log)
  } catch (error) {
    post({ type: 'fatal', message: messageOf(error) })
    return
  }
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    try {
      api.dispose()
    } catch (error) {
      log.warn('dispose failed', error)
    }
  }
  // Any graceful exit flushes the clipboard (a Copy outlives the helper) and frees the class.
  process.on('exit', dispose)
  const core = createHelperCore({
    api,
    post,
    onShutdown: () => {
      dispose()
      process.exit(0)
    }
  })

  // The thread's window messages: fast right after a request, slowly otherwise.
  let busyUntil = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(tick, Date.now() < busyUntil ? PUMP_BUSY_MS : PUMP_IDLE_MS)
  }
  const tick = (): void => {
    timer = null
    try {
      api.pumpMessages()
    } catch (error) {
      report(error)
    }
    schedule()
  }

  port.on('message', (event) => {
    core.handle(event.data)
    busyUntil = Date.now() + PUMP_BUSY_WINDOW_MS
    schedule()
  })
  schedule()
  post({ type: 'ready', pid: process.pid })
  if (warmUp) {
    try {
      warmUp(api)
    } catch (error) {
      log.warn('warm-up failed', error)
    }
  }
}
