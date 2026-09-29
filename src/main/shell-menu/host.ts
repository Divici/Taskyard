import type {
  EnumerateOptions,
  ShellMenuItem,
  ShellMenuTarget,
  ShowMenuOutcome,
  ShowMenuRequest
} from '../win32/shell-menu-api'
import { parseHelperMessage, type HelperMessage, type HelperRequest } from './protocol'

/**
 * Main's side of the shell-menu helper: forks it (an Electron utilityProcess), talks to it over
 * its MessagePort, and keeps Taskyard safe from it. Requests run one at a time. Each must see
 * its menu on screen (`showing`) or its answer within REQUEST_TIMEOUT_MS of being asked — else
 * it is rejected, and a helper that was working on it is killed so no menu can appear late. A
 * menu that is on screen never times out. A helper that dies rejects the request it was
 * serving and is respawned by the next request. Callers fall back to Taskyard's own menu on any
 * rejection.
 */

export const REQUEST_TIMEOUT_MS = 30_000
/** On dispose a ready helper gets this long to flush the clipboard and exit before it is killed. */
export const SHUTDOWN_GRACE_MS = 1_000

/** The slice of Electron's UtilityProcess the host uses. */
export interface HelperChild {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  kill(): boolean
}

export interface ShellMenuHostDeps {
  /** `utilityProcess.fork(helper.js)` in the app. */
  fork(): HelperChild
  /** `AllowSetForegroundWindow(pid)`: main has the foreground right after a right-click. */
  allowForeground(pid: number): void
  /**
   * Dismisses the menu owned by `ownerHwnd` (`PostMessage(owner, WM_CANCELMODE)`): the helper's
   * thread is inside TrackPopupMenuEx and cannot be asked. Needed by `cancelShows`.
   */
  cancelMenu?(ownerHwnd: bigint): void
  log: {
    info(message: string): void
    warn(message: string, ...details: unknown[]): void
    error(message: string, ...details: unknown[]): void
  }
  timeoutMs?: number
}

export type ShellMenuErrorCode =
  | 'timeout'
  | 'helper-exited'
  | 'helper-failed'
  | 'request-failed'
  | 'disposed'
  /** `cancelShows`: a newer menu replaced this one before it was shown (not a failure). */
  | 'cancelled'

export class ShellMenuError extends Error {
  constructor(
    readonly code: ShellMenuErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ShellMenuError'
  }
}

export interface HelperInfo {
  pid: number
}

export interface ShowingInfo {
  ownerHwnd: bigint
  pid: number
}

export interface ShellMenuHost {
  /** Spawns the helper if needed and resolves once it is ready (pre-warming the first menu). */
  start(): Promise<HelperInfo>
  /**
   * `request` may be a builder, called when the helper takes the request (not when it is queued),
   * so what it names — e.g. an icon menu's current paths — is read as late as possible. A builder
   * that throws rejects the request with its error; nothing is posted.
   *
   * Phase 4 review: while the helper runs the command chosen in the previous menu (`invoking`:
   * a modal confirmation may be up for a long time), a new show is rejected at once
   * (`request-failed`) so the caller shows its own menu instead of waiting.
   */
  show(request: ShowMenuRequest | (() => ShowMenuRequest)): Promise<ShowMenuOutcome>
  enumerate(target: ShellMenuTarget, options?: Partial<EnumerateOptions>): Promise<ShellMenuItem[]>
  invokeVerb(target: ShellMenuTarget, verb: string): Promise<void>
  /**
   * Phase 3 (a new right-click replaces the menu before it): show requests still queued are
   * rejected as `cancelled`; the one the helper is serving is dismissed with WM_CANCELMODE — now
   * if its menu is on screen, else the moment it shows — and resolves with its outcome as usual.
   * Enumerate and invoke requests are left alone.
   */
  cancelShows(): void
  /** Called while a menu is on screen: its owner window (Phase 3: Peek counts it as Taskyard's). */
  onShowing(listener: (info: ShowingInfo) => void): () => void
  /** The running, ready helper, or null. */
  readonly helper: HelperInfo | null
  dispose(): void
}

type ShowBody = Omit<Extract<HelperRequest, { type: 'show' }>, 'id'>
type Body =
  | ShowBody
  | Omit<Extract<HelperRequest, { type: 'enumerate' }>, 'id'>
  | Omit<Extract<HelperRequest, { type: 'invoke' }>, 'id'>

type Result = Extract<HelperMessage, { type: 'result' }>['result']

interface Pending {
  id: number
  body: Body
  /** A show built when the helper takes it (the body until then is a placeholder). */
  build: (() => Body) | null
  resolve(result: Result): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout> | null
  showing: boolean
  /** The menu's owner window once it is on screen. */
  ownerHwnd: bigint | null
  /** cancelShows ran while the helper was building this menu: dismiss it when it shows. */
  cancelOnShow: boolean
  /** Phase 4 review: its menu closed and the helper runs the chosen command (`invoking`). */
  invoking: boolean
}

interface Helper {
  child: HelperChild
  pid: number | null
  exited: boolean
  /** Settles when the helper says ready (or fails to start). */
  ready: Promise<HelperInfo>
}

/** Why a show is refused while the helper runs the previous menu's command. */
const commandRunning = (): ShellMenuError =>
  new ShellMenuError(
    'request-failed',
    'the shell-menu helper is running the command chosen in the previous menu'
  )

/** The body a builder-made show carries until it is built (only its `type` is read before). */
const PENDING_SHOW: ShowBody = {
  type: 'show',
  target: { kind: 'desktop-background' },
  point: { x: 0, y: 0 },
  extendedVerbs: false,
  taskyardItems: [],
  interceptVerbs: [],
  interceptSubmenus: [],
  hideVerbs: [],
  hideSubmenus: [],
  replaceSubmenus: []
}

export function createShellMenuHost(deps: ShellMenuHostDeps): ShellMenuHost {
  const { log } = deps
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS
  let helper: Helper | null = null
  let active: Pending | null = null
  const queue: Pending[] = []
  const showingListeners = new Set<(info: ShowingInfo) => void>()
  let nextId = 1
  let disposed = false

  const settle = (pending: Pending): void => {
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.timer = null
    if (active === pending) active = null
    const index = queue.indexOf(pending)
    if (index >= 0) queue.splice(index, 1)
  }

  const fail = (pending: Pending, error: Error): void => {
    settle(pending)
    pending.reject(error)
  }

  /** Forgets the current helper (killed or exited); its later messages are ignored. */
  const drop = (kill: boolean): void => {
    const current = helper
    helper = null
    if (current && kill) current.child.kill()
  }

  /** Forks a helper, or returns why it could not be forked. */
  const spawn = (): Helper | ShellMenuError => {
    let child: HelperChild
    try {
      child = deps.fork()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(`shell-menu: could not start the helper: ${message}`)
      return new ShellMenuError('helper-failed', message)
    }
    let markReady: (info: HelperInfo) => void = () => {}
    let markFailed: (error: ShellMenuError) => void = () => {}
    const ready = new Promise<HelperInfo>((resolve, reject) => {
      markReady = resolve
      markFailed = reject
    })
    // A start nobody awaits (the spawn behind a request) must not become an unhandled rejection.
    ready.catch(() => undefined)
    const self: Helper = { child, pid: null, exited: false, ready }

    child.on('message', (raw: unknown) => {
      if (helper !== self) return
      let message: HelperMessage
      try {
        message = parseHelperMessage(raw)
      } catch (error) {
        log.warn('shell-menu: ignored a malformed helper message', error)
        return
      }
      onMessage(self, message, markReady, markFailed)
    })
    child.on('exit', (code: number) => {
      self.exited = true
      if (helper !== self) return
      log.warn(`shell-menu: helper exited (code ${code})`)
      drop(false)
      const error = new ShellMenuError(
        'helper-exited',
        `the shell-menu helper exited (code ${code})`
      )
      markFailed(error)
      if (self.pid === null) {
        // It died starting up: what waited for it fails (no respawn loop).
        for (const pending of [...queue]) fail(pending, error)
        return
      }
      if (active) fail(active, error)
      // Requests still waiting are the "next request": they get a new helper.
      pump()
    })
    return self
  }

  const onMessage = (
    self: Helper,
    message: HelperMessage,
    markReady: (info: HelperInfo) => void,
    markFailed: (error: ShellMenuError) => void
  ): void => {
    switch (message.type) {
      case 'ready':
        self.pid = message.pid
        log.info(`shell-menu: helper ready (pid ${message.pid})`)
        markReady({ pid: message.pid })
        pump()
        return
      case 'fatal':
        log.error(`shell-menu: helper failed to start: ${message.message}`)
        drop(true)
        markFailed(new ShellMenuError('helper-failed', message.message))
        for (const pending of [...queue])
          fail(pending, new ShellMenuError('helper-failed', message.message))
        return
      case 'crash':
        log.error(`shell-menu: helper reported an error: ${message.message}`)
        return
      case 'warn':
        log.warn(`shell-menu: helper: ${message.message}`)
        return
      case 'showing': {
        if (active?.id !== message.id) return
        active.showing = true
        if (active.timer !== null) clearTimeout(active.timer)
        active.timer = null
        const info: ShowingInfo = { ownerHwnd: BigInt(message.ownerHwnd), pid: self.pid ?? 0 }
        active.ownerHwnd = info.ownerHwnd
        for (const listener of showingListeners) listener(info)
        if (active.cancelOnShow) cancelMenu(info.ownerHwnd)
        return
      }
      case 'invoking': {
        if (active?.id !== message.id) return
        active.invoking = true
        // Shows queued behind it would appear only after the command (a modal dialog may keep
        // it for minutes), at an old point: their callers show their own menus now.
        for (const pending of [...queue]) {
          if (pending.body.type === 'show') fail(pending, commandRunning())
        }
        return
      }
      case 'result':
      case 'error': {
        if (active?.id !== message.id) return
        const pending = active
        settle(pending)
        if (message.type === 'result') pending.resolve(message.result)
        else pending.reject(new ShellMenuError('request-failed', message.message))
        pump()
        return
      }
    }
  }

  /** Starts the next queued request when the helper is ready and idle (spawning it if needed). */
  const pump = (): void => {
    if (disposed || active || queue.length === 0) return
    if (!helper) {
      const spawned = spawn()
      if (spawned instanceof ShellMenuError) {
        for (const pending of [...queue]) fail(pending, spawned)
        return
      }
      helper = spawned
    }
    // Not ready yet: `ready` pumps again; `fatal`, `exit` or a timeout fail what waits.
    const pid = helper.pid
    if (pid === null) return
    const next = queue.shift()!
    if (next.build !== null) {
      // Built now, when the helper takes it: what it names is as current as it can be.
      try {
        next.body = next.build()
      } catch (error) {
        fail(next, error instanceof Error ? error : new Error(String(error)))
        pump()
        return
      }
    }
    active = next
    if (next.body.type === 'show') deps.allowForeground(pid)
    helper.child.postMessage({ ...next.body, id: next.id })
  }

  const request = (body: Body, build: (() => Body) | null = null): Promise<Result> => {
    if (disposed)
      return Promise.reject(new ShellMenuError('disposed', 'the shell-menu host is disposed'))
    if (body.type === 'show' && active?.body.type === 'show' && active.invoking)
      return Promise.reject(commandRunning())
    return new Promise<Result>((resolve, reject) => {
      const pending: Pending = {
        id: nextId++,
        body,
        build,
        resolve,
        reject,
        timer: null,
        showing: false,
        ownerHwnd: null,
        cancelOnShow: false,
        invoking: false
      }
      pending.timer = setTimeout(() => {
        pending.timer = null
        const wasActive = active === pending
        fail(
          pending,
          new ShellMenuError('timeout', `no answer from the shell-menu helper in ${timeoutMs} ms`)
        )
        // Working on it, or still not ready after the whole timeout: the helper is hung.
        if (wasActive || (helper !== null && helper.pid === null)) {
          log.warn(`shell-menu: request ${pending.id} timed out; killing the helper`)
          drop(true)
        }
        pump()
      }, timeoutMs)
      queue.push(pending)
      pump()
    })
  }

  const cancelMenu = (ownerHwnd: bigint): void => {
    try {
      deps.cancelMenu?.(ownerHwnd)
    } catch (error) {
      log.warn('shell-menu: could not dismiss the open menu', error)
    }
  }

  const expectKind = <K extends Result['kind']>(
    result: Result,
    kind: K
  ): Extract<Result, { kind: K }> => {
    if (result.kind !== kind)
      throw new ShellMenuError('request-failed', `expected a ${kind} result`)
    return result as Extract<Result, { kind: K }>
  }

  return {
    start() {
      if (disposed)
        return Promise.reject(new ShellMenuError('disposed', 'the shell-menu host is disposed'))
      if (!helper) {
        const spawned = spawn()
        if (spawned instanceof ShellMenuError) return Promise.reject(spawned)
        helper = spawned
      }
      const current = helper
      if (current.pid !== null) return Promise.resolve({ pid: current.pid })
      let timer: ReturnType<typeof setTimeout> | null = null
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (helper === current && current.pid === null) drop(true)
          reject(
            new ShellMenuError('timeout', `the shell-menu helper was not ready in ${timeoutMs} ms`)
          )
        }, timeoutMs)
      })
      return Promise.race([current.ready, timeout]).finally(() => {
        if (timer !== null) clearTimeout(timer)
      })
    },

    async show(showRequest) {
      const result =
        typeof showRequest === 'function'
          ? await request(PENDING_SHOW, () => ({ type: 'show', ...showRequest() }))
          : await request({ type: 'show', ...showRequest })
      return expectKind(result, 'show').outcome
    },

    async enumerate(target, options = {}) {
      const result = await request({
        type: 'enumerate',
        target,
        extendedVerbs: options.extendedVerbs ?? false,
        ...(options.source ? { source: options.source } : {}),
        ...(options.pasteState ? { pasteState: true } : {})
      })
      return expectKind(result, 'enumerate').items
    },

    async invokeVerb(target, verb) {
      expectKind(await request({ type: 'invoke', target, verb }), 'invoke')
    },

    cancelShows() {
      const error = new ShellMenuError('cancelled', 'a newer menu replaced this one')
      for (const pending of [...queue]) {
        if (pending.body.type === 'show') fail(pending, error)
      }
      // A menu whose command runs is closed; WM_CANCELMODE cannot end a modal dialog anyway.
      if (active?.body.type !== 'show' || active.invoking) return
      if (active.ownerHwnd !== null) cancelMenu(active.ownerHwnd)
      else active.cancelOnShow = true
    },

    onShowing(listener) {
      showingListeners.add(listener)
      return () => {
        showingListeners.delete(listener)
      }
    },

    get helper() {
      return helper && helper.pid !== null ? { pid: helper.pid } : null
    },

    dispose() {
      if (disposed) return
      disposed = true
      const error = new ShellMenuError('disposed', 'the shell-menu host is disposed')
      if (active) fail(active, error)
      for (const pending of [...queue]) fail(pending, error)
      showingListeners.clear()
      const current = helper
      if (current === null || current.pid === null) {
        drop(true)
        return
      }
      // A ready helper flushes the OLE clipboard (a Copy outlives it) and exits by itself.
      drop(false)
      current.child.postMessage({ type: 'shutdown' })
      const timer = setTimeout(() => {
        if (!current.exited) current.child.kill()
      }, SHUTDOWN_GRACE_MS)
      ;(timer as { unref?: () => void }).unref?.()
    }
  }
}
