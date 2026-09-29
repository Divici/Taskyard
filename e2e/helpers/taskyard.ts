import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { ENV } from '../../src/main/app/env'
import { LOG_FILE_NAME } from '../../src/main/app/logger'

/** Built main-process entry produced by `npm run build` (run in global-setup). */
export const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')

/** Absolute path of the Electron binary from the electron npm package. */
export const ELECTRON_BINARY = createRequire(__filename)('electron') as string

export interface Profile {
  userData: string
  /**
   * The desktop folder this launch scans and watches (TASKYARD_DESKTOP_DIRS): a temp folder, so
   * no e2e run ever reads or changes the real desktop.
   */
  desktop: string
  logFile: string
  readLog(): string
  dispose(): void
}

/** A throwaway userData directory, so each launch has its own logs and single-instance lock. */
export function createProfile(): Profile {
  const userData = mkdtempSync(join(tmpdir(), 'taskyard-e2e-'))
  const desktop = mkdtempSync(join(tmpdir(), 'taskyard-e2e-desktop-'))
  const logFile = join(userData, 'logs', LOG_FILE_NAME)
  return {
    userData,
    desktop,
    logFile,
    readLog: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''),
    dispose: () => {
      for (const dir of [userData, desktop]) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      }
    }
  }
}

/**
 * Native menus (Phase 3) during e2e runs: `off` (the default) keeps Taskyard's own right-click
 * menus, so no real Windows menu ever pops up under an automated run; `scripted` runs the fake
 * shell-menu helper that the spec scripts from the main process (e2e/shell-menu.spec.ts).
 */
export type ShellMenuE2eMode = 'off' | 'scripted'

/** Environment for a Taskyard process bound to the given profile. */
export function taskyardEnv(
  profile: Profile,
  shellMenu: ShellMenuE2eMode = 'off'
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  }
  env[ENV.userData] = profile.userData
  env[ENV.desktopDirs] = profile.desktop
  env[ENV.fakeShellMenu] = shellMenu === 'scripted' ? '1' : '0'
  return env
}

export interface LaunchOptions {
  /**
   * Launch as Windows does at sign-in (`--autostart`: tray only, no start-up Peek). The default,
   * so specs start from the steady state; a user launch (false) Peeks for up to 8 s (Phase 11).
   */
  autostart?: boolean
  /** Native menus: off (Taskyard's menus, the default) or the scripted fake helper. */
  shellMenu?: ShellMenuE2eMode
}

export function launchTaskyard(
  profile: Profile,
  { autostart = true, shellMenu = 'off' }: LaunchOptions = {}
): Promise<ElectronApplication> {
  const args = autostart ? [MAIN_ENTRY, '--autostart'] : [MAIN_ENTRY]
  return electron.launch({ args, env: taskyardEnv(profile, shellMenu) })
}

/**
 * The desktop window of the primary display: the one that places new desktop items (the
 * single reconcile writer), so loose icons appear there.
 */
export async function primaryWindow(app: ElectronApplication): Promise<Page> {
  const primaryId = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().id)
  const displayCount = await app.evaluate(({ screen }) => screen.getAllDisplays().length)
  let found: Page | undefined
  await expect
    .poll(
      () => {
        const windows = app.windows()
        found = windows.find(
          (page) => new URL(page.url()).searchParams.get('displayId') === String(primaryId)
        )
        return windows.length >= displayCount && found !== undefined
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  await found!.waitForLoadState('domcontentloaded')
  return found!
}
