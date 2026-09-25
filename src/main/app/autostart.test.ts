import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOSTART_ARG, createAutostart, isAutostartLaunch, type LoginItemApp } from './autostart'

type FakeLoginApp = LoginItemApp & {
  setLoginItemSettings: ReturnType<typeof vi.fn<LoginItemApp['setLoginItemSettings']>>
  getLoginItemSettings: ReturnType<typeof vi.fn<LoginItemApp['getLoginItemSettings']>>
}

/** A stand-in for Electron's login-item API: never touches the real Windows Run key. */
function fakeApp(isPackaged = true, openAtLogin = false): FakeLoginApp {
  let state = { openAtLogin, args: openAtLogin ? [AUTOSTART_ARG] : ([] as string[]) }
  const app = {
    isPackaged,
    setLoginItemSettings: vi.fn((settings: { openAtLogin: boolean; args?: string[] }) => {
      state = { openAtLogin: settings.openAtLogin, args: settings.args ?? [] }
    }),
    getLoginItemSettings: vi.fn((options?: { args?: string[] }) => ({
      openAtLogin:
        state.openAtLogin && JSON.stringify(options?.args ?? []) === JSON.stringify(state.args)
    }))
  } satisfies LoginItemApp
  return app
}

const log = { info: vi.fn(), warn: vi.fn() }

beforeEach(() => {
  log.info.mockClear()
  log.warn.mockClear()
})

describe('autostart (Start with Windows)', () => {
  it('registers the login item with the --autostart argument', () => {
    const app = fakeApp()
    const autostart = createAutostart({ app, log })

    expect(autostart.apply(true)).toBe(true)
    expect(app.setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({
      openAtLogin: true,
      args: ['--autostart']
    })
    expect(autostart.isEnabled()).toBe(true)
    expect(log.info).toHaveBeenCalledWith('autostart: Taskyard starts with Windows')
  })

  it('removes it again when turned off', () => {
    const app = fakeApp(true, true)
    const autostart = createAutostart({ app, log })

    autostart.apply(false)
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({
      openAtLogin: false,
      args: ['--autostart']
    })
    expect(autostart.isEnabled()).toBe(false)
  })

  it('sync writes only when Windows disagrees with the setting', () => {
    const app = fakeApp(true, true)
    const autostart = createAutostart({ app, log })

    autostart.sync({ autostart: true })
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
    autostart.sync({ autostart: false })
    expect(app.setLoginItemSettings).toHaveBeenCalledOnce()
    autostart.sync({ autostart: false })
    expect(app.setLoginItemSettings).toHaveBeenCalledOnce()
  })

  it('a dev (unpackaged) build never registers electron.exe as a login item', () => {
    const app = fakeApp(false)
    const autostart = createAutostart({ app, log })

    expect(autostart.apply(true)).toBe(false)
    autostart.sync({ autostart: true })
    expect(app.setLoginItemSettings).not.toHaveBeenCalled()
    expect(autostart.isEnabled()).toBe(false)
    expect(log.info).toHaveBeenCalledOnce()
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('dev build'))
  })

  it('a failing registration is logged, not thrown', () => {
    const app = fakeApp()
    app.setLoginItemSettings.mockImplementation(() => {
      throw new Error('access denied')
    })
    const autostart = createAutostart({ app, log })

    expect(autostart.apply(true)).toBe(false)
    expect(log.warn).toHaveBeenCalledWith(
      'autostart: could not update the login item',
      expect.any(Error)
    )
  })
})

describe('isAutostartLaunch', () => {
  it('is true only when Windows started Taskyard at sign-in', () => {
    expect(isAutostartLaunch(['C:\\Taskyard\\Taskyard.exe', '--autostart'])).toBe(true)
    expect(isAutostartLaunch(['C:\\Taskyard\\Taskyard.exe'])).toBe(false)
    expect(isAutostartLaunch(['electron.exe', 'out/main/index.js', '--autostarted'])).toBe(false)
  })
})
