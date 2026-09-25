import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { LogLevel } from 'electron-log'

/** Environment overrides read by the main process (names only; values come from the shell). */
export const ENV = {
  /** Replaces app.getPath('userData') — isolates logs, data and the single-instance lock. */
  userData: 'TASKYARD_USER_DATA',
  /** One of electron-log's levels; anything else falls back to `info`. */
  logLevel: 'TASKYARD_LOG_LEVEL',
  /** `1` = use the in-memory Win32 fake instead of koffi (no z-order seating). */
  noWin32: 'TASKYARD_NO_WIN32',
  /**
   * Semicolon list replacing the scanned desktop folders (first = the user Desktop, where moves
   * land). Tests and e2e runs point it at temp folders so nothing touches the real desktop.
   */
  desktopDirs: 'TASKYARD_DESKTOP_DIRS'
} as const

type Env = Partial<Record<string, string | undefined>>

const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'verbose', 'debug', 'silly']

/**
 * Applies TASKYARD_USER_DATA via app.setPath('userData'). Must run before the single-instance
 * lock is requested and before anything writes to userData (the lock and logs live there).
 * Returns the applied absolute path, or null when no override is set.
 */
export function applyUserDataOverride(
  app: { setPath(name: 'userData', path: string): void },
  env: Env
): string | null {
  const raw = env[ENV.userData]?.trim()
  if (!raw) return null

  const dir = resolve(raw)
  // Electron throws if the directory does not exist yet.
  mkdirSync(dir, { recursive: true })
  app.setPath('userData', dir)
  return dir
}

export function resolveLogLevel(raw: string | undefined): LogLevel {
  const candidate = raw?.trim().toLowerCase()
  return LOG_LEVELS.find((level) => level === candidate) ?? 'info'
}
