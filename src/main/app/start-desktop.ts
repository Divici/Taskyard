import type { Win32Api } from '../win32/api'
import type { Win32Selection } from '../win32'

/** What startDesktop needs from the manager it creates. */
export interface StartableDesktop {
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
  registerIpc: (manager: M) => void
  /** Electron's `dialog.showErrorBox`. */
  showErrorBox: (title: string, content: string) => void
  quit: () => void
  log: { info(message: string): void; error(message: string): void }
  logFile: string
}

/**
 * Opens the desktop windows. Without working Win32 on Windows it opens nothing: an opaque,
 * full-screen window that cannot be seated would sit on top of the user's apps. It explains why
 * in a dialog and quits instead.
 */
export function startDesktop<M extends StartableDesktop>(
  win32: Win32Selection,
  deps: StartDesktopDeps<M>
): M | null {
  if (win32.kind === 'unavailable') {
    deps.log.error(`app: Win32 unavailable (${win32.reason}); quitting`)
    deps.showErrorBox(
      'Taskyard cannot start',
      `Taskyard could not load its Windows integration: ${win32.reason}.\n\n` +
        'It needs it to sit on the desktop behind your apps, so it will close now.\n\n' +
        `Details are in the log: ${deps.logFile}`
    )
    deps.quit()
    return null
  }
  deps.clearApplicationMenu()
  const manager = deps.createManager(win32.api)
  deps.registerIpc(manager)
  manager.start()
  deps.log.info(`desktop: ${manager.windows().length} display window(s), ${win32.kind} win32`)
  return manager
}
