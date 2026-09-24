import {
  installQuitFlush,
  installSessionEndFlush,
  QUIT_FLUSH_TIMEOUT_MS,
  type QuitFlushLog,
  type QuitFlushTarget,
  type WindowCreatedApp
} from './quit-flush'

/** Electron's before-quit event: `defaultPrevented` tells whether some listener held the quit. */
export interface BeforeQuitEvent {
  preventDefault(): void
  readonly defaultPrevented: boolean
}

/** The slice of Electron's `app` the quit path uses. */
export interface QuitPathApp {
  on(event: 'before-quit', listener: (event: BeforeQuitEvent) => void): unknown
  on(event: 'will-quit', listener: () => void): unknown
  on(event: 'window-all-closed', listener: () => void): unknown
  on(event: 'browser-window-created', listener: Parameters<WindowCreatedApp['on']>[1]): unknown
  quit(): void
}

/** The desktop window manager, as far as quitting goes. */
export interface QuittableDesktop {
  readonly quitting: boolean
  prepareToQuit(): void
  cancelQuit(): void
  dispose(): void
}

export interface QuitPathDeps {
  storage: QuitFlushTarget & { flushAllSync(): void }
  /** The desktop windows, or null before they exist (or when they could not start). */
  desktop: () => QuittableDesktop | null
  log: QuitFlushLog & { warn(message: string): void }
  flushTimeoutMs?: number
}

/**
 * The app's one quit path, in this order:
 * 1. Stores first: every before-quit waits while a write is pending (flush, then quit again).
 *    While it waits the desktop windows keep refusing outside closes: the quit has not happened.
 * 2. Only a before-quit nobody held marks the desktop windows quitting, so they may close. Once
 *    it goes ahead nothing of ours can stop it: the windows accept the close and ignore their
 *    page's beforeunload veto (`will-prevent-unload`, in desktop-window.ts), however long the
 *    closing takes. The one real cancellation left is a before-quit listener registered after
 *    this one that holds the quit; Electron reports it in `defaultPrevented`, checked once the
 *    event is over, and the desktop windows are guarded again (`cancelQuit`).
 * 3. will-quit writes any change accepted after the last before-quit (still in its debounce)
 *    synchronously, then disposes the desktop windows' timers and hooks.
 * 4. window-all-closed quits only when nothing is left to recreate a window.
 * 5. Windows log-off/shutdown sends no before-quit: each window's session-end flushes
 *    synchronously instead.
 */
export function installQuitPath(app: QuitPathApp, deps: QuitPathDeps): void {
  const { storage, log } = deps
  let heldCheck: ReturnType<typeof setTimeout> | null = null

  const disarm = (): void => {
    if (heldCheck !== null) clearTimeout(heldCheck)
    heldCheck = null
  }

  // Registered first, so the listener below can see whether the flush held the quit.
  installQuitFlush(app, storage, log, { timeoutMs: deps.flushTimeoutMs ?? QUIT_FLUSH_TIMEOUT_MS })
  installSessionEndFlush(app, () => storage.flushAllSync(), log)

  app.on('before-quit', (event) => {
    if (event.defaultPrevented) {
      log.info('app: before-quit (held until the stores are on disk)')
      return
    }
    log.info('app: before-quit')
    const desktop = deps.desktop()
    if (desktop === null) return
    desktop.prepareToQuit()
    disarm()
    // Every listener has run by the next tick: only then is `defaultPrevented` final.
    heldCheck = setTimeout(() => {
      heldCheck = null
      if (!event.defaultPrevented || !desktop.quitting) return
      log.warn(
        'app: quit cancelled (a before-quit listener prevented it); the desktop windows stay'
      )
      desktop.cancelQuit()
    }, 0)
  })

  app.on('will-quit', () => {
    disarm()
    // A change accepted after the last unheld before-quit (a window saving while it closed) is
    // still in its 300 ms debounce, and the process ends right after will-quit.
    if (storage.hasPendingWrites()) {
      try {
        storage.flushAllSync()
        log.info('quit: wrote late changes at will-quit')
      } catch (error) {
        log.error('quit: writing late changes at will-quit failed', error)
      }
    }
    deps.desktop()?.dispose()
  })

  // A window destroyed from outside is recreated by the manager, so only quit when quitting.
  app.on('window-all-closed', () => {
    const desktop = deps.desktop()
    if (desktop === null || desktop.quitting) app.quit()
  })
}
