import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TaskyardApi } from '../src/preload/api'
import type { LayoutFile, SettingsFile } from '../src/shared/schema'
import { createProfile, launchTaskyard, primaryWindow, type Profile } from './helpers/taskyard'

// Phase 11 acceptance. Everything runs against a temp profile and a temp desktop folder
// (TASKYARD_USER_DATA / TASKYARD_DESKTOP_DIRS): nothing touches the real desktop or settings.

type BridgeWindow = { taskyard: TaskyardApi }

function readJson<T>(profile: Profile, name: string): T {
  return JSON.parse(readFileSync(join(profile.userData, name), 'utf8')) as T
}

/** Main's layout as the renderer sees it (after main's own boot-time changes). */
function loadLayout(page: Page): Promise<LayoutFile> {
  return page.evaluate(async () => {
    const { taskyard } = globalThis as unknown as BridgeWindow
    return (await taskyard.storage.load('layout')).data
  })
}

/**
 * Quits through the app's own quit path (Controller ruling R11: "kill the app" is a graceful quit
 * — before-quit holds the quit until every debounced save is on disk; a hard kill cannot persist
 * a save still in its 300 ms debounce). Resolves once the process has exited.
 */
async function quitThroughApp(app: ElectronApplication, page: Page): Promise<void> {
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()))
  await page
    .evaluate(() => (globalThis as unknown as BridgeWindow).taskyard.app.quit())
    .catch(() => {
      // The page may close before the reply arrives: that is the quit working.
    })
  await exited
}

test('settings and layout survive a quit 200 ms after the change; files added or deleted while closed are handled', async () => {
  const profile = createProfile()
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    writeFileSync(join(profile.desktop, `${name}.txt`), name)
  }
  let app: ElectronApplication | undefined
  try {
    app = await launchTaskyard(profile)
    let page = await primaryWindow(app)
    for (const name of ['Alpha', 'Bravo', 'Charlie']) {
      await expect(page.getByRole('option', { name, exact: true })).toBeVisible()
    }
    // First run: keep the desktop as it is (a settings change of its own: firstRunDone).
    await page.getByRole('button', { name: 'Keep my desktop as it is' }).click()
    await expect(page.getByRole('dialog', { name: 'Welcome to Taskyard' })).toBeHidden()

    // A layout change: a group named Work.
    await page.mouse.click(600, 400, { button: 'right' })
    await page.getByRole('menuitem', { name: 'New group here' }).click()
    await expect(page.getByRole('textbox', { name: 'Rename group New group' })).toBeFocused()
    await page.keyboard.type('Work')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('region', { name: 'Work' })).toBeVisible()

    // Three settings through the inspector (desktop menu › Settings): theme, extensions, opacity.
    await page.mouse.click(1200, 900, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
    const inspector = page.getByRole('dialog', { name: 'Settings' })
    await expect(inspector).toBeVisible()
    await inspector.getByRole('radio', { name: 'Light' }).click()
    await inspector.getByRole('switch', { name: 'Show file extensions' }).click()
    const opacity = inspector.getByRole('slider', { name: 'Glass opacity' })
    await opacity.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    // Live: the root follows at once, and the labels gained their extensions.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(inspector.getByText('43%')).toBeVisible()
    await expect(page.getByRole('option', { name: 'Alpha.txt', exact: true })).toBeVisible()

    // 200 ms later (inside the 300 ms write debounce), quit.
    await page.waitForTimeout(200)
    await quitThroughApp(app, page)
    app = undefined

    const settings = readJson<SettingsFile>(profile, 'settings.json')
    expect(settings).toMatchObject({
      theme: 'light',
      showExtensions: true,
      glassOpacity: 43,
      firstRunDone: true
    })
    const saved = readJson<LayoutFile>(profile, 'layout.json')
    expect(saved.displays.flatMap((d) => d.groups).map((g) => g.title)).toEqual(['Work'])
    const idOf = (name: string): string =>
      Object.entries(saved.paths).find(([, path]) => path.endsWith(`\\${name}.txt`))![0]
    const bravo = idOf('Bravo')

    // While Taskyard is closed: one file added, one deleted.
    writeFileSync(join(profile.desktop, 'Delta.txt'), 'delta')
    unlinkSync(join(profile.desktop, 'Bravo.txt'))

    app = await launchTaskyard(profile)
    page = await primaryWindow(app)

    // Settings restored (and applied), no first-run card, no inspector.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(
      await page.evaluate(() => document.documentElement.style.getPropertyValue('--glass-opacity'))
    ).toBe('0.43')
    await expect(page.getByRole('dialog', { name: 'Welcome to Taskyard' })).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)

    // Layout restored.
    await expect(page.getByRole('region', { name: 'Work' })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Alpha.txt', exact: true })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Charlie.txt', exact: true })).toBeVisible()
    // The new file is placed; the deleted one is hidden (its placement remembered, stamped).
    await expect(page.getByRole('option', { name: 'Delta.txt', exact: true })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Bravo.txt', exact: true })).toHaveCount(0)
    await expect
      .poll(async () => {
        const layout = await loadLayout(page)
        const delta = Object.entries(layout.paths).find(([, p]) => p.endsWith('\\Delta.txt'))
        return {
          deltaPlaced:
            delta !== undefined && layout.displays.some((d) => d.loose[delta[0]] !== undefined),
          bravoStamped: layout.lastSeen[bravo] !== undefined
        }
      })
      .toEqual({ deltaPlaced: true, bravoStamped: true })
  } finally {
    await app?.close()
    profile.dispose()
  }
})

test('a user launch Peeks, a sign-in launch goes to the tray, and an unhandled main error is only logged', async () => {
  const profile = createProfile()
  writeFileSync(join(profile.desktop, 'Notes.txt'), 'notes')
  let app: ElectronApplication | undefined
  try {
    // Started by the user: Taskyard Peeks over whatever is open, and the tray icon is there.
    app = await launchTaskyard(profile, { autostart: false })
    let page = await primaryWindow(app)
    await expect(page.locator('main')).toHaveAttribute('data-peeking', 'true')
    await expect.poll(() => profile.readLog()).toContain('tray: ready')
    await app.close()
    app = undefined

    // Started by Windows at sign-in (--autostart): tray only, no Peek.
    const before = profile.readLog().length
    app = await launchTaskyard(profile)
    page = await primaryWindow(app)
    await expect
      .poll(() => profile.readLog().slice(before))
      .toContain('app: started by Windows at sign-in (tray only, no Peek)')
    await page.waitForTimeout(1_000)
    await expect(page.locator('main')).toHaveAttribute('data-peeking', 'false')
    expect(profile.readLog().slice(before)).not.toContain('peek: on')

    // An exception nobody catches in main is logged, and the app keeps running.
    await app.evaluate(() => {
      setTimeout(() => {
        throw new Error('e2e: a callback in main failed')
      }, 0)
    })
    await expect.poll(() => profile.readLog()).toContain('main: unhandled error (still running)')
    expect(profile.readLog()).toContain('e2e: a callback in main failed')
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(
      await app.evaluate(({ screen }) => screen.getAllDisplays().length)
    )
    await expect(page.getByRole('option', { name: 'Notes', exact: true })).toBeVisible()
  } finally {
    await app?.close()
    profile.dispose()
  }
})
