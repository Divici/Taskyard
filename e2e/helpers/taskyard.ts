import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'
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

/** Environment for a Taskyard process bound to the given profile. */
export function taskyardEnv(profile: Profile): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  }
  env[ENV.userData] = profile.userData
  env[ENV.desktopDirs] = profile.desktop
  return env
}

export function launchTaskyard(profile: Profile): Promise<ElectronApplication> {
  return electron.launch({ args: [MAIN_ENTRY], env: taskyardEnv(profile) })
}
