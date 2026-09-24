import { ENV } from '../app/env'
import type { Win32Api } from './api'
import type { Koffi } from './bindings'
import { createFakeWin32Api } from './fake-api'
import { createKoffiWin32Api, type KoffiWin32ApiOptions } from './koffi-api'
import { loadUser32 } from './load-user32'

export type { Win32Api } from './api'

export interface CreateWin32ApiDeps {
  env: Partial<Record<string, string | undefined>>
  platform: NodeJS.Platform
  isPackaged: boolean
  log: {
    info(message: string): void
    warn(message: string, ...details: unknown[]): void
    error(message: string, ...details: unknown[]): void
  }
  /** Imports koffi lazily so a missing or ABI-incompatible native binary is caught and logged. */
  importKoffi: () => Promise<Koffi>
  createKoffiApi?: (koffi: Koffi, options: KoffiWin32ApiOptions) => Win32Api
}

/**
 * `koffi`: real Win32. `fake`: the in-memory fake (TASKYARD_NO_WIN32=1, or not Windows).
 * `unavailable`: Windows, but koffi failed; the app must not open unseated desktop windows.
 */
export type Win32Selection =
  | { kind: 'koffi'; api: Win32Api }
  | { kind: 'fake'; api: Win32Api }
  | { kind: 'unavailable'; reason: string }

/** Why the fake must be used here, or null when real Win32 is available. */
export function fakeReason(
  env: CreateWin32ApiDeps['env'],
  platform: NodeJS.Platform
): string | null {
  if (env[ENV.noWin32] === '1') return `${ENV.noWin32}=1`
  if (platform !== 'win32') return `platform ${platform}`
  return null
}

/**
 * The Win32 layer for this process: koffi on Windows, the in-memory fake under
 * `TASKYARD_NO_WIN32=1` or elsewhere. Also runs Phase 1's user32 probe (its log line is what
 * `verify:koffi` waits for). Never throws. If koffi fails on Windows the result is
 * `unavailable`, never the fake: fake-seated full-screen windows would cover the user's apps.
 */
export async function createWin32Api(deps: CreateWin32ApiDeps): Promise<Win32Selection> {
  const { log } = deps
  const reason = fakeReason(deps.env, deps.platform)
  if (reason !== null) {
    log.info(`win32: using the fake api (${reason})`)
    return { api: createFakeWin32Api(), kind: 'fake' }
  }

  let koffi: Koffi | null = null
  const user32 = await loadUser32({
    importKoffi: async () => (koffi = await deps.importKoffi()),
    isPackaged: deps.isPackaged,
    log
  })
  if (user32 === null || koffi === null) {
    return { kind: 'unavailable', reason: 'koffi could not load user32.dll (see the log)' }
  }
  try {
    const create = deps.createKoffiApi ?? createKoffiWin32Api
    return { api: create(koffi, { log }), kind: 'koffi' }
  } catch (error) {
    log.error('win32: koffi bindings failed', error)
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'unavailable', reason: `the Win32 bindings failed: ${message}` }
  }
}
