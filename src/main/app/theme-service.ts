import { IPC, type ThemeInfo } from '@shared/ipc'
import { handleTrusted, type IpcMainLike, type TrustedHandlerOptions } from '../ipc/sender-guard'

/** The slice of Electron's `nativeTheme` used here. */
export interface NativeThemeLike {
  /** The Windows *app* theme (Settings › Personalization › Colors), while themeSource is system. */
  readonly shouldUseDarkColors: boolean
  /** Settings › Accessibility › Visual effects › Transparency effects is off. */
  readonly prefersReducedTransparency: boolean
  on(event: 'updated', listener: () => void): unknown
  removeListener(event: 'updated', listener: () => void): unknown
}

export interface ThemeService {
  current(): ThemeInfo
  /** Re-reads nativeTheme and broadcasts `theme:changed` if anything changed. */
  check(): void
  start(): void
  stop(): void
}

export function readThemeInfo(nativeTheme: NativeThemeLike): ThemeInfo {
  return {
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    prefersReducedTransparency: nativeTheme.prefersReducedTransparency
  }
}

/**
 * Follows the Windows theme for the renderers. `nativeTheme.themeSource` is never set, so
 * `shouldUseDarkColors` always reports Windows itself; the Dark/Light override is applied by the
 * renderer (src/renderer/lib/theme.ts). Checked on nativeTheme's `updated` and on every
 * WM_SETTINGCHANGE (the transparency switch does not always raise `updated`).
 */
export function createThemeService(deps: {
  nativeTheme: NativeThemeLike
  emit: (info: ThemeInfo) => void
}): ThemeService {
  let last = readThemeInfo(deps.nativeTheme)

  const check = (): void => {
    const next = readThemeInfo(deps.nativeTheme)
    if (
      next.shouldUseDarkColors === last.shouldUseDarkColors &&
      next.prefersReducedTransparency === last.prefersReducedTransparency
    ) {
      return
    }
    last = next
    deps.emit({ ...next })
  }

  return {
    current: () => readThemeInfo(deps.nativeTheme),
    check,
    start: () => {
      deps.nativeTheme.on('updated', check)
    },
    stop: () => {
      deps.nativeTheme.removeListener('updated', check)
    }
  }
}

/** `theme:get` for the Taskyard renderer only. */
export function registerThemeIpc(
  ipcMain: IpcMainLike,
  service: Pick<ThemeService, 'current'>,
  trust: TrustedHandlerOptions
): () => void {
  handleTrusted(ipcMain, IPC.theme.get, trust, () => service.current())
  return () => ipcMain.removeHandler(IPC.theme.get)
}
