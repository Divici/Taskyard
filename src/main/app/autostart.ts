import type { SettingsFile } from '@shared/schema'

// Start with Windows (Assumption 12: on by default; Settings and the tray toggle it). Windows
// starts Taskyard at sign-in with `--autostart`, and such a launch goes to the tray without a
// Peek (src/main/index.ts). Settings is the source of truth: the login item follows it.

export const AUTOSTART_ARG = '--autostart'

/** The slice of Electron's `app` used here (injectable: tests never touch the Run key). */
export interface LoginItemApp {
  readonly isPackaged: boolean
  setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void
  getLoginItemSettings(options?: { args?: string[] }): { openAtLogin: boolean }
}

export interface AutostartDeps {
  app: LoginItemApp
  log: { info(message: string): void; warn(message: string, ...details: unknown[]): void }
}

export interface Autostart {
  /** Registers (true) or removes (false) the login item; true when Windows now has it so. */
  apply(openAtLogin: boolean): boolean
  /** Whether Windows starts Taskyard at sign-in now. */
  isEnabled(): boolean
  /** Makes the login item follow Settings › Start with Windows (writes only on a difference). */
  sync(settings: Pick<SettingsFile, 'autostart'>): void
}

const ARGS = [AUTOSTART_ARG]

/**
 * A dev build is `electron.exe` running out/main: registering that as a login item would start a
 * bare Electron at every sign-in, so only the packaged app touches the login item.
 */
export function createAutostart({ app, log }: AutostartDeps): Autostart {
  let explained = false
  const devBuild = (): boolean => {
    if (app.isPackaged) return false
    if (!explained) {
      explained = true
      log.info('autostart: dev build, the Windows login item is left alone')
    }
    return true
  }

  const isEnabled = (): boolean => {
    if (!app.isPackaged) return false
    try {
      return app.getLoginItemSettings({ args: ARGS }).openAtLogin
    } catch (error) {
      log.warn('autostart: could not read the login item', error)
      return false
    }
  }

  const apply = (openAtLogin: boolean): boolean => {
    if (devBuild()) return false
    try {
      app.setLoginItemSettings({ openAtLogin, args: ARGS })
    } catch (error) {
      log.warn('autostart: could not update the login item', error)
      return false
    }
    log.info(
      openAtLogin
        ? 'autostart: Taskyard starts with Windows'
        : 'autostart: Taskyard no longer starts with Windows'
    )
    return isEnabled() === openAtLogin
  }

  return {
    apply,
    isEnabled,
    sync(settings) {
      if (devBuild()) return
      if (isEnabled() !== settings.autostart) apply(settings.autostart)
    }
  }
}

/** Windows started this launch at sign-in (the login item's argument). */
export function isAutostartLaunch(argv: readonly string[]): boolean {
  return argv.includes(AUTOSTART_ARG)
}
