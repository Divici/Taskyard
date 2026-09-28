import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import koffi from 'koffi'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { defaultSettings } from '../src/shared/defaults'
import { loadScriptWin32 } from '../scripts/lib/win32-script'
import { createProfile, taskyardEnv, type Profile } from './helpers/taskyard'
import { desktopWindowInfo, win32Probe } from './helpers/win32'

// Phase 12: the packaged app (npm run dist → dist/win-unpacked/Taskyard.exe), not out/ under a
// bare electron.exe: asar, asarUnpack'ed koffi, the real exe name and AppUserModelId. Temp
// profile and temp desktop as everywhere; Start with Windows is off in the profile so the run
// never writes the Run key. The installer itself (install → run → uninstall) is checked by hand
// and recorded in the Phase 12 report.

const EXE = resolve(__dirname, '../dist/win-unpacked/Taskyard.exe')
/** Electron's tray icon lives on a hidden message window of this class, in the app's process. */
const TRAY_WINDOW_CLASS = 'Electron_NotifyIconHostWindow'

test.skip(!existsSync(EXE), `${EXE} is missing: run "npm run dist" first`)

test('the packaged exe starts to the tray, loads koffi and seats every desktop window above the shell', async () => {
  const profile: Profile = createProfile()
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ ...defaultSettings(), autostart: false, firstRunDone: true })
  )
  let app: ElectronApplication | undefined
  try {
    // As Windows starts it at sign-in: tray only, no start-up Peek.
    app = await electron.launch({
      executablePath: EXE,
      args: ['--autostart'],
      env: taskyardEnv(profile)
    })
    expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true)

    // koffi's native binary loaded from app.asar.unpacked.
    await expect.poll(() => profile.readLog()).toContain('koffi: user32 loaded (packaged)')

    // The tray icon: logged, and its host window exists in this process.
    await expect.poll(() => profile.readLog()).toContain('tray: ready')
    expect(profile.readLog()).not.toContain('the icon image failed to load')
    const win32 = loadScriptWin32(koffi)
    // The main process itself (Playwright's child handle is not it for a packaged exe).
    const pid = await app.evaluate(() => process.pid)
    await expect
      .poll(() => win32.findWindows(TRAY_WINDOW_CLASS).some((w) => win32.processIdOf(w) === pid))
      .toBe(true)

    // Every display's window: visible, a tool window (no taskbar button), above the shell window.
    const probe = await win32Probe()
    const windows = await desktopWindowInfo(app)
    const displays = await app.evaluate(({ screen }) => screen.getAllDisplays().length)
    expect(windows).toHaveLength(displays)
    await expect
      .poll(() => windows.every((w) => probe.isVisible(w.hwnd) && probe.isSeated(w.hwnd)), {
        timeout: 10_000
      })
      .toBe(true)
    for (const window of windows) {
      expect(probe.exStyle(window.hwnd) & probe.WS_EX_TOOLWINDOW).toBe(probe.WS_EX_TOOLWINDOW)
      expect(probe.isIconic(window.hwnd)).toBe(false)
    }
  } finally {
    await app?.close()
    profile.dispose()
  }
})
