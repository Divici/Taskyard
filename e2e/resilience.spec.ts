import { expect, test, type ElectronApplication } from '@playwright/test'
import { createProfile, launchTaskyard, type Profile } from './helpers/taskyard'
import { desktopWindowInfo, win32Probe, type DesktopWindowInfo } from './helpers/win32'

test.describe.serial('resilience', () => {
  let profile: Profile
  let app: ElectronApplication
  let windows: DesktopWindowInfo[]

  test.beforeAll(async () => {
    profile = createProfile()
    app = await launchTaskyard(profile)
    await app.firstWindow()
    await expect.poll(() => profile.readLog()).toMatch(/desktop: \d+ display window\(s\), koffi/)
    const probe = await win32Probe()
    windows = await desktopWindowInfo(app)
    await expect
      .poll(() => windows.every((w) => probe.isVisible(w.hwnd) && probe.isSeated(w.hwnd)))
      .toBe(true)
  })

  test.afterAll(async () => {
    // The last test quits the app itself.
    await app?.close().catch(() => {})
    profile?.dispose()
  })

  test('ignores a real Alt+F4 on a focused desktop window', async () => {
    const probe = await win32Probe()
    const [first] = windows

    expect(probe.altF4(first.hwnd)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    expect(probe.isVisible(first.hwnd)).toBe(true)
    expect(probe.isSeated(first.hwnd)).toBe(true)
    expect((await desktopWindowInfo(app)).map((w) => w.hwnd)).toEqual(windows.map((w) => w.hwnd))
    expect(app.process().exitCode).toBeNull()
    expect(profile.readLog()).not.toContain('app: before-quit')
  })

  test('ignores a real Ctrl+W (the default menu is gone)', async () => {
    const probe = await win32Probe()
    const [first] = windows

    expect(probe.ctrl(first.hwnd, 'w')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    expect(probe.isVisible(first.hwnd)).toBe(true)
    expect((await desktopWindowInfo(app)).map((w) => w.hwnd)).toEqual(windows.map((w) => w.hwnd))
    expect(app.process().exitCode).toBeNull()
    expect(profile.readLog()).not.toContain('app: before-quit')
    expect(profile.readLog()).not.toContain('close requested')
  })

  test('does not reload on a real Ctrl+R', async () => {
    const probe = await win32Probe()
    const [first] = windows
    const marker = (value?: number): Promise<unknown> =>
      app.evaluate(
        ({ BrowserWindow }, [hwnd, set]) => {
          const window = BrowserWindow.getAllWindows().find(
            (w) => w.getNativeWindowHandle().readBigUInt64LE(0).toString() === hwnd
          )
          const script =
            set === null ? 'globalThis.__taskyardMarker' : `globalThis.__taskyardMarker = ${set}`
          return window?.webContents.executeJavaScript(script)
        },
        [first.hwnd.toString(), value ?? null] as const
      )
    await marker(42)

    expect(probe.ctrl(first.hwnd, 'r')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    // A reload would have created a fresh page without the marker.
    expect(await marker()).toBe(42)
  })

  test('reloads a crashed renderer and paints again', async () => {
    const [first] = windows

    await app.evaluate(({ BrowserWindow }, hwnd) => {
      const window = BrowserWindow.getAllWindows().find(
        (w) => w.getNativeWindowHandle().readBigUInt64LE(0).toString() === hwnd
      )
      window?.webContents.forcefullyCrashRenderer()
    }, first.hwnd.toString())

    await expect
      .poll(() => profile.readLog())
      .toContain('desktop: reloading the renderer on display')
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }, hwnd) => {
          const window = BrowserWindow.getAllWindows().find(
            (w) => w.getNativeWindowHandle().readBigUInt64LE(0).toString() === hwnd
          )
          return (
            window !== undefined &&
            !window.webContents.isCrashed() &&
            !window.webContents.isLoading()
          )
        }, first.hwnd.toString())
      )
      .toBe(true)
  })

  test('quits gracefully (before-quit runs) on a WM_CLOSE from another process', async () => {
    const probe = await win32Probe()
    const exited = new Promise<number | null>((resolve) => {
      app.process().once('exit', (code) => resolve(code))
    })

    probe.postClose(windows[0].hwnd)

    expect(await exited).toBe(0)
    const log = profile.readLog()
    expect(log).toContain('desktop: close requested for display')
    expect(log).toContain('app: before-quit')
  })
})
