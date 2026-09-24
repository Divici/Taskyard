import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sleepSync } from './sleep-sync'
import type { ScriptWin32 } from './win32-script'

/**
 * Kills and restarts explorer.exe for `verify:zorder`. Everything here is synchronous so it can
 * also run from a Ctrl+C handler: the script must never leave the user without a shell.
 */
export interface ExplorerControl {
  /** The taskbar (`Shell_TrayWnd`) exists, i.e. Explorer is running as the shell. */
  isShellUp(): boolean
  kill(): void
  /** Starts explorer.exe with the user's default environment (not this npm process's). */
  start(): void
  /** Starts Explorer until the shell is up; true when it is. */
  ensureRunning(options?: { timeoutMs?: number; attempts?: number }): boolean
}

export interface ExplorerLog {
  info(message: string): void
  warn(message: string): void
}

const EXPLORER = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'explorer.exe')
/** npm, tsx and Taskyard variables that must not leak into the user's shell. */
const LEAKY_ENV = /^(npm_|TASKYARD_|ELECTRON_|INIT_CWD$|NODE$|NODE_OPTIONS$)/i

/** `taskkill` arguments that end only this session's Explorer (never another user's). */
export function explorerKillArgs(sessionId: number): string[] {
  return ['/f', '/fi', `SESSION eq ${sessionId}`, '/im', 'explorer.exe']
}

/** `tasklist` arguments that list only this session's explorer.exe. */
export function explorerListArgs(sessionId: number): string[] {
  return ['/fi', 'IMAGENAME eq explorer.exe', '/fi', `SESSION eq ${sessionId}`, '/nh', '/fo', 'csv']
}

export function explorerControl(win32: ScriptWin32, log: ExplorerLog): ExplorerControl {
  const session = win32.sessionId()
  const explorerProcessRunning = (): boolean => {
    const result = spawnSync('tasklist', explorerListArgs(session), {
      encoding: 'utf8',
      windowsHide: true
    })
    return /"explorer\.exe"/i.test(result.stdout ?? '')
  }
  const isShellUp = (): boolean => win32.findWindows('Shell_TrayWnd').length > 0

  const shellEnvironment = (): Record<string, string | undefined> => {
    const env = win32.userEnvironment()
    if (env) return env
    log.warn(
      'CreateEnvironmentBlock failed; starting Explorer with a filtered copy of this environment'
    )
    return Object.fromEntries(Object.entries(process.env).filter(([key]) => !LEAKY_ENV.test(key)))
  }

  const start = (): void => {
    const env = shellEnvironment()
    const child = spawn(EXPLORER, [], {
      detached: true,
      stdio: 'ignore',
      env,
      cwd: env['USERPROFILE'] ?? homedir()
    })
    child.unref()
  }

  const waitForShell = (timeoutMs: number): boolean => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (isShellUp()) return true
      sleepSync(250)
    }
    return isShellUp()
  }

  return {
    isShellUp,
    kill() {
      spawnSync('taskkill', explorerKillArgs(session), { stdio: 'ignore', windowsHide: true })
    },
    start,
    ensureRunning({ timeoutMs = 20_000, attempts = 3 } = {}) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (isShellUp()) return true
        // An explorer.exe that is still starting will register the shell on its own.
        if (!explorerProcessRunning() || attempt > 1) {
          log.info(`starting explorer.exe (attempt ${attempt})`)
          start()
        }
        if (waitForShell(timeoutMs)) return true
      }
      return isShellUp()
    }
  }
}
