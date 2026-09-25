import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchStandInApp } from '../scripts/lib/stand-in-app'
import { defaultSettings } from '../src/shared/defaults'
import type { Hwnd } from '../src/main/win32/api'
import {
  createProfile,
  ELECTRON_BINARY,
  launchTaskyard,
  primaryWindow,
  taskyardEnv,
  type Profile
} from './helpers/taskyard'
import { desktopWindowInfo, win32Probe, type Win32Probe } from './helpers/win32'

// Interactive Windows run: a real global shortcut, a real maximized app window (a stand-in
// Electron window we start — never one of the user's apps), and real clicks. Temp profile and
// temp desktop folder, as everywhere in e2e.

const STAND_IN = 'taskyard-e2e peek stand-in'
const DEFAULT_SHORTCUT = 'Ctrl+Alt+Space'
/** Used when another app on the machine already owns the default. */
const FALLBACK_SHORTCUT = 'Ctrl+Alt+Shift+Space'
const VK: Readonly<Record<string, number>> = { Ctrl: 0x11, Alt: 0x12, Shift: 0x10, Space: 0x20 }
const keysOf = (accelerator: string): number[] => accelerator.split('+').map((key) => VK[key])

/** A screen point (physical px) inside `rect`, at fractions of its size. */
const at = (
  rect: { x: number; y: number; width: number; height: number },
  fx: number,
  fy: number
): { x: number; y: number } => ({
  x: Math.round(rect.x + rect.width * fx),
  y: Math.round(rect.y + rect.height * fy)
})

/** Waits for main's verdict on the Peek shortcut: true when `accelerator` is registered. */
async function shortcutRegistered(profile: Profile, accelerator: string): Promise<boolean> {
  const ok = `shortcuts: Peek shortcut is ${accelerator}`
  const taken = `shortcuts: could not register ${accelerator}`
  await expect
    .poll(() => profile.readLog().includes(ok) || profile.readLog().includes(taken))
    .toBe(true)
  return profile.readLog().includes(ok)
}

test('Peek: the shortcut shows the groups over a maximized window; a click on the desktop puts them back below', async () => {
  const profile: Profile = createProfile()
  const standInDir = mkdtempSync(join(tmpdir(), 'taskyard-e2e-standin-'))
  let app: ElectronApplication | undefined
  let standIn: ChildProcess | undefined
  try {
    app = await launchTaskyard(profile)
    let page: Page = await primaryWindow(app)
    let accelerator = DEFAULT_SHORTCUT
    if (!(await shortcutRegistered(profile, DEFAULT_SHORTCUT))) {
      // Another app owns Ctrl+Alt+Space here: the user is told (register → false → error), and
      // Peek is tested on a rebound shortcut, set the way Settings will: in settings.json.
      await expect(
        page.getByText('Ctrl+Alt+Space is already used by another app, so Peek has no shortcut.')
      ).toBeVisible()
      await app.close()
      accelerator = FALLBACK_SHORTCUT
      writeFileSync(
        join(profile.userData, 'settings.json'),
        JSON.stringify({ ...defaultSettings(), peekShortcut: accelerator })
      )
      app = await launchTaskyard(profile)
      page = await primaryWindow(app)
      await expect.poll(() => profile.readLog()).toContain(`Peek shortcut is ${accelerator}`)
    }
    test.info().annotations.push({ type: 'peek shortcut', description: accelerator })
    const probe: Win32Probe = await win32Probe()
    const primaryId = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().id)
    const primary = (await desktopWindowInfo(app)).find((w) => w.displayId === primaryId)!
    const peeking = (): Promise<string | null> =>
      page.getByRole('main').getAttribute('data-peeking')

    // A group to show: desktop menu → New group here → "Work".
    await page.mouse.click(600, 400, { button: 'right' })
    await page.getByRole('menuitem', { name: 'New group here' }).click()
    await expect(page.getByRole('textbox', { name: 'Rename group New group' })).toBeFocused()
    await page.keyboard.type('Work')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('region', { name: 'Work' })).toBeVisible()

    // A maximized app window covers the desktop (and so Taskyard, which sits on it).
    standIn = launchStandInApp(ELECTRON_BINARY, standInDir, taskyardEnv(profile), {
      title: STAND_IN,
      maximize: true
    })
    let standInHwnd: Hwnd | null = null
    await expect
      .poll(() => (standInHwnd = probe.findWindowByTitle(STAND_IN)) !== null, { timeout: 15_000 })
      .toBe(true)
    const middle = at(primary.screenBounds, 0.5, 0.5)
    // The group's middle in screen pixels (CSS px × scale factor from the window's origin).
    const scale = primary.screenBounds.width / primary.bounds.width
    const groupPoint = {
      x: Math.round(primary.screenBounds.x + (600 + 140) * scale),
      y: Math.round(primary.screenBounds.y + (400 + 100) * scale)
    }
    await expect.poll(() => probe.windowAt(middle.x, middle.y)).toBe(standInHwnd)
    await expect.poll(() => probe.windowAt(groupPoint.x, groupPoint.y)).toBe(standInHwnd)

    // Peek: the real global shortcut, pressed while the stand-in has the focus.
    expect(probe.chord(standInHwnd!, keysOf(accelerator))).toBe(true)
    await expect.poll(peeking).toBe('true')
    await expect.poll(() => probe.windowAt(groupPoint.x, groupPoint.y)).toBe(primary.hwnd)
    await expect.poll(() => probe.windowAt(middle.x, middle.y)).toBe(primary.hwnd)
    await expect(page.getByRole('region', { name: 'Work' })).toBeVisible()
    expect(profile.readLog()).toContain('peek: on')

    // A click on the group keeps the Peek (it is activity, not "outside").
    probe.clickAt(groupPoint.x, groupPoint.y)
    await page.waitForTimeout(300)
    expect(await peeking()).toBe('true')

    // A click on the empty desktop ends it: the groups go back below the maximized window.
    const empty = at(primary.screenBounds, 0.85, 0.3)
    expect(probe.windowAt(empty.x, empty.y)).toBe(primary.hwnd)
    probe.clickAt(empty.x, empty.y)
    await expect.poll(peeking).toBe('false')
    await expect.poll(() => probe.windowAt(groupPoint.x, groupPoint.y)).toBe(standInHwnd)
    await expect.poll(() => probe.windowAt(middle.x, middle.y)).toBe(standInHwnd)
    expect(profile.readLog()).toContain('peek: click outside a group, unpeeking')
    expect(probe.isSeated(primary.hwnd)).toBe(true)

    // The shortcut toggles: on again, and off again with a second press.
    expect(probe.chord(standInHwnd!, keysOf(accelerator))).toBe(true)
    await expect.poll(peeking).toBe('true')
    expect(probe.chord(primary.hwnd, keysOf(accelerator))).toBe(true)
    await expect.poll(peeking).toBe('false')
    await expect.poll(() => probe.windowAt(middle.x, middle.y)).toBe(standInHwnd)
  } finally {
    standIn?.kill()
    await app?.close()
    profile.dispose()
    rmSync(standInDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
