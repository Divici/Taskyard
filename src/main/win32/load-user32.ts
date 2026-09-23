export const USER32_DLL = 'user32.dll'

/** The part of the koffi module needed to open a DLL. */
export interface KoffiLoader<TLib = unknown> {
  load(path: string): TLib
}

export interface LoadUser32Deps<TLib> {
  /** Imports koffi lazily so a missing or ABI-incompatible native binary is caught and logged. */
  importKoffi: () => KoffiLoader<TLib> | Promise<KoffiLoader<TLib>>
  isPackaged: boolean
  log: {
    info(message: string): void
    error(message: string, error: unknown): void
  }
}

function flavour(isPackaged: boolean): 'packaged' | 'dev' {
  return isPackaged ? 'packaged' : 'dev'
}

/** The success line `npm run verify:koffi` waits for in the packaged app's log. */
export function user32LoadedMessage(isPackaged: boolean): string {
  return `koffi: user32 loaded (${flavour(isPackaged)})`
}

/**
 * Startup probe: opens user32.dll through koffi and logs the outcome. Never throws — without
 * Win32 the app still runs, it just cannot seat its windows (Phase 2).
 */
export async function loadUser32<TLib>(deps: LoadUser32Deps<TLib>): Promise<TLib | null> {
  try {
    const koffi = await deps.importKoffi()
    const lib = koffi.load(USER32_DLL)
    deps.log.info(user32LoadedMessage(deps.isPackaged))
    return lib
  } catch (error) {
    deps.log.error(`koffi: user32 load failed (${flavour(deps.isPackaged)})`, error)
    return null
  }
}
