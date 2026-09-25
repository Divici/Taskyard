import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { IPC, type ThemeInfo } from '@shared/ipc'
import { FakeIpcMain, TRUSTED_RENDERER_URL } from '../ipc/fake-ipc-main'
import { createThemeService, registerThemeIpc, type NativeThemeLike } from './theme-service'

class FakeNativeTheme extends EventEmitter implements NativeThemeLike {
  shouldUseDarkColors = true
  prefersReducedTransparency = false
  themeSource: 'system' | 'light' | 'dark' = 'system'

  /** Windows changed a setting: Electron fires `updated`. */
  change(
    patch: Partial<Pick<FakeNativeTheme, 'shouldUseDarkColors' | 'prefersReducedTransparency'>>
  ): void {
    Object.assign(this, patch)
    this.emit('updated')
  }
}

function setup(): {
  nativeTheme: FakeNativeTheme
  emitted: ThemeInfo[]
  service: ReturnType<typeof createThemeService>
} {
  const nativeTheme = new FakeNativeTheme()
  const emitted: ThemeInfo[] = []
  const service = createThemeService({ nativeTheme, emit: (info) => emitted.push(info) })
  return { nativeTheme, emitted, service }
}

describe('createThemeService', () => {
  it("reports the Windows app theme and transparency setting (nativeTheme's view)", () => {
    const { service } = setup()
    expect(service.current()).toEqual({
      shouldUseDarkColors: true,
      prefersReducedTransparency: false
    })
  })

  it('broadcasts theme:changed when Windows switches between dark and light', () => {
    const { nativeTheme, emitted, service } = setup()
    service.start()
    nativeTheme.change({ shouldUseDarkColors: false })
    expect(emitted).toEqual([{ shouldUseDarkColors: false, prefersReducedTransparency: false }])
    service.stop()
  })

  it('broadcasts when transparency effects are switched off (checked on WM_SETTINGCHANGE too)', () => {
    const { nativeTheme, emitted, service } = setup()
    service.start()
    nativeTheme.prefersReducedTransparency = true // no `updated` from Electron for this one
    service.check()
    expect(emitted).toEqual([{ shouldUseDarkColors: true, prefersReducedTransparency: true }])
    service.stop()
  })

  it('stays quiet when nothing it reports changed (high contrast, repeated events)', () => {
    const { nativeTheme, emitted, service } = setup()
    service.start()
    nativeTheme.change({})
    service.check()
    expect(emitted).toEqual([])
    service.stop()
  })

  it('never overrides the Windows theme (themeSource stays system)', () => {
    const { nativeTheme, service } = setup()
    service.start()
    expect(nativeTheme.themeSource).toBe('system')
    service.stop()
  })

  it('stop removes the listener', () => {
    const { nativeTheme, emitted, service } = setup()
    service.start()
    service.stop()
    expect(nativeTheme.listenerCount('updated')).toBe(0)
    nativeTheme.change({ shouldUseDarkColors: false })
    expect(emitted).toEqual([])
  })
})

describe('registerThemeIpc', () => {
  it('answers theme:get for the Taskyard renderer only', async () => {
    const { service } = setup()
    const ipc = new FakeIpcMain()
    const log = { warn: vi.fn() }
    registerThemeIpc(ipc, service, {
      isTrustedSender: (event) => event.senderFrame?.url === TRUSTED_RENDERER_URL,
      log
    })

    expect(await ipc.invoke(IPC.theme.get)).toEqual({
      shouldUseDarkColors: true,
      prefersReducedTransparency: false
    })
    await expect(
      ipc.invokeFrom(
        { sender: { id: 9 }, senderFrame: { url: 'https://evil.example/' } },
        IPC.theme.get
      )
    ).rejects.toThrow(/untrusted/)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })
})
