import type { Win32Api } from '../win32/api'
import type { Win32Selection } from '../win32'

/** What startDesktop needs from the manager it creates. */
export interface StartableDesktop {
  /** All or nothing: on a throw it has already closed what it opened (see the manager). */
  start(): void
  windows(): readonly unknown[]
}

export interface StartDesktopDeps<M extends StartableDesktop = StartableDesktop> {
  /**
   * `Menu.setApplicationMenu(null)`: Electron's default menu would give every desktop window
   * Ctrl+W (close → quit), Ctrl+R (reload), Ctrl+Shift+I (DevTools), Ctrl+M and zoom.
   */
  clearApplicationMenu: () => void
  createManager: (api: Win32Api) => M
  /** Registers the manager's IPC handlers; may return a function that removes them again. */
  registerIpc: (manager: M) => (() => void) | void
  /** Electron's `dialog.showErrorBox`. */
  showErrorBox: (title: string, content: string) => void
  quit: () => void
  log: { info(message: string): void; error(message: string, ...details: unknown[]): void }
  logFile: string
}

const DIALOG_TITLE = 'Taskyard cannot start'

/**
 * Opens the desktop windows. Without working Win32 on Windows it opens nothing: an opaque,
 * full-screen window that cannot be seated would sit on top of the user's apps. It explains why
 * in a dialog and quits instead. The same happens when the windows fail to start: the app never
 * keeps running half-started (some windows up, no sentinel, nothing that lets them close).
 */
export function startDesktop<M extends StartableDesktop>(
  win32: Win32Selection,
  deps: StartDesktopDeps<M>
): M | null {
  const giveUp = (reason: string, logLine: string, error?: unknown): null => {
    if (error === undefined) deps.log.error(logLine)
    else deps.log.error(logLine, error)
    deps.showErrorBox(DIALOG_TITLE, `${reason}\n\nDetails are in the log: ${deps.logFile}`)
    deps.quit()
    return null
  }

  if (win32.kind === 'unavailable') {
    return giveUp(
      `Taskyard could not load its Windows integration: ${win32.reason}.\n\n` +
        'It needs it to sit on the desktop behind your apps, so it will close now.',
      `app: Win32 unavailable (${win32.reason}); quitting`
    )
  }

  let unregisterIpc: (() => void) | void = undefined
  try {
    deps.clearApplicationMenu()
    const manager = deps.createManager(win32.api)
    unregisterIpc = deps.registerIpc(manager)
    manager.start()
    deps.log.info(`desktop: ${manager.windows().length} display window(s), ${win32.kind} win32`)
    return manager
  } catch (error) {
    unregisterIpc?.()
    const message = error instanceof Error ? error.message : String(error)
    return giveUp(
      `Taskyard could not open its desktop windows: ${message}.\n\nIt will close now.`,
      `app: the desktop windows failed to start (${message}); quitting`,
      error
    )
  }
}
