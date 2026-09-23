import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TaskyardApi } from '../src/preload/api'
import { createProfile, launchTaskyard, type Profile } from './helpers/taskyard'

test.describe.serial('smoke', () => {
  let profile: Profile
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    profile = createProfile()
    app = await launchTaskyard(profile)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await app?.close()
    profile?.dispose()
  })

  test('opens exactly one window, titled "Taskyard"', async () => {
    await expect(page).toHaveTitle('Taskyard')
    await expect(page.getByRole('heading', { level: 1, name: 'Taskyard' })).toBeVisible()

    const titles = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.getTitle())
    )
    expect(titles).toEqual(['Taskyard'])
    expect(app.windows()).toHaveLength(1)
  })

  test('renders in an OS-sandboxed renderer without Node globals', async () => {
    const renderer = await app.evaluate(({ app, BrowserWindow }) => {
      const pid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
      const metric = app.getAppMetrics().find((process) => process.pid === pid)
      return { type: metric?.type, sandboxed: metric?.sandboxed }
    })
    expect(renderer).toEqual({ type: 'Tab', sandboxed: true })

    const leaked = await page.evaluate(() => ({
      require: typeof (globalThis as Record<string, unknown>).require,
      process: typeof (globalThis as Record<string, unknown>).process
    }))
    expect(leaked).toEqual({ require: 'undefined', process: 'undefined' })
  })

  test('runs the CommonJS preload and exposes window.taskyard', async () => {
    const exposed = await page.evaluate(
      () => (globalThis as unknown as { taskyard: TaskyardApi }).taskyard.versions
    )
    const actual = await app.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }))

    expect(exposed).toEqual(actual)
  })

  test('logs the koffi user32 probe into the isolated profile', async () => {
    await expect.poll(() => profile.readLog()).toContain('koffi: user32 loaded (dev)')
    expect(profile.readLog()).not.toContain('koffi: user32 load failed')
  })
})
