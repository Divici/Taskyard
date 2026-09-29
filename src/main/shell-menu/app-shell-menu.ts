import type { Win32Api } from '../win32/api'
import {
  createShellMenuHost,
  type HelperChild,
  type ShellMenuHost,
  type ShellMenuHostDeps
} from './host'

/** The helper's bundle next to main's (electron.vite.config.ts builds it as its own entry). */
export const SHELL_MENU_HELPER_FILE = 'shell-menu-helper.js'
/** How the helper appears among Electron's processes. */
export const SHELL_MENU_SERVICE_NAME = 'Taskyard Shell Menu'

export interface AppShellMenuDeps {
  /** Electron's `utilityProcess` (only `fork` is used). */
  utilityProcess: {
    fork(modulePath: string, args: string[], options: { serviceName: string }): HelperChild
  }
  /** Absolute path of the helper bundle (`join(__dirname, SHELL_MENU_HELPER_FILE)`). */
  helperFile: string
  win32: Pick<Win32Api, 'allowSetForegroundWindow'>
  log: ShellMenuHostDeps['log']
}

/**
 * The app's shell-menu host: forks the helper as an Electron utility process and lets it take
 * the foreground (main has it right after the user's right-click) before each menu.
 */
export function createAppShellMenu(deps: AppShellMenuDeps): ShellMenuHost {
  const { log } = deps
  return createShellMenuHost({
    fork: () =>
      deps.utilityProcess.fork(deps.helperFile, [], { serviceName: SHELL_MENU_SERVICE_NAME }),
    allowForeground: (pid) => {
      if (!deps.win32.allowSetForegroundWindow(pid)) {
        log.warn(
          `shell-menu: AllowSetForegroundWindow(${pid}) was refused; the menu may not take the foreground`
        )
      }
    },
    log
  })
}
