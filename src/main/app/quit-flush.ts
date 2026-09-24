/** The slice of Electron's `app` used to hold quitting until the stores are on disk. */
export interface QuitApp {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}

/** A window that reports Windows ending the session (shutdown, restart, log-off). */
export interface SessionEndSource {
  on(event: 'session-end', listener: (...args: unknown[]) => void): unknown
}

export interface WindowCreatedApp {
  on(
    event: 'browser-window-created',
    listener: (event: unknown, window: SessionEndSource) => void
  ): unknown
}

export interface QuitFlushLog {
  info(message: string): void
  error(message: string, error: unknown): void
}

export const QUIT_FLUSH_TIMEOUT_MS = 5_000

/** What must reach the disk before the app may quit. */
export interface QuitFlushTarget {
  hasPendingWrites(): boolean
  flushAll(): Promise<void>
}

/**
 * Holds every `before-quit` while any store still has data that is not on disk: cancels it,
 * awaits `flushAll()`, then quits again. This applies to *each* quit, so a quit that something
 * else cancelled and the user repeated after more changes flushes again. Repeated quit requests
 * during a flush are held too. A flush that fails, throws or hangs past `timeoutMs` is logged
 * and the very next quit is let through, so a broken disk can never keep the app alive.
 */
export function installQuitFlush(
  app: QuitApp,
  target: QuitFlushTarget,
  log: QuitFlushLog,
  { timeoutMs = QUIT_FLUSH_TIMEOUT_MS }: { timeoutMs?: number } = {}
): void {
  let flushing = false
  let giveUp = false

  app.on('before-quit', (event) => {
    if (flushing) {
      event.preventDefault()
      return
    }
    if (giveUp) {
      giveUp = false
      return
    }
    if (!target.hasPendingWrites()) return

    event.preventDefault()
    flushing = true

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`flush timed out after ${timeoutMs} ms`)),
        timeoutMs
      )
    })

    let flushed: Promise<void>
    try {
      flushed = target.flushAll()
    } catch (error) {
      // A flush that throws synchronously must not escape into Electron and block the quit.
      flushed = Promise.reject(error)
    }

    Promise.race([flushed, timeout])
      .then(
        () => log.info('quit: stores flushed'),
        (error: unknown) => {
          log.error('quit: flushing stores failed', error)
          giveUp = true
        }
      )
      .finally(() => {
        clearTimeout(timer)
        flushing = false
        app.quit()
      })
  })
}

/**
 * Windows does not emit `before-quit` when the session ends; each window gets `session-end`
 * instead and the process may be killed right after. Flush synchronously, once.
 */
export function installSessionEndFlush(
  app: WindowCreatedApp,
  flushSync: () => void,
  log: QuitFlushLog
): void {
  let flushed = false
  const onSessionEnd = (): void => {
    if (flushed) return
    flushed = true
    try {
      flushSync()
      log.info('session-end: stores flushed')
    } catch (error) {
      log.error('session-end: flushing stores failed', error)
    }
  }

  app.on('browser-window-created', (_event, window) => {
    window.on('session-end', onSessionEnd)
  })
}
