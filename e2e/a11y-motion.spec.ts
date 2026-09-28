import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { defaultSettings } from '../src/shared/defaults'
import type { TaskyardApi } from '../src/preload/api'
import { createProfile, launchTaskyard, primaryWindow, type Profile } from './helpers/taskyard'

// Phase 12, in real Chromium (jsdom has no cascade layers, media queries or keyboard
// contextmenu): the keyboard route to every menu, and the motion kill switch.

type Api = { taskyard: TaskyardApi }

async function newGroup(page: Page, title: string): Promise<void> {
  await page.mouse.click(600, 400, { button: 'right' })
  await page.getByRole('menuitem', { name: 'New group here' }).click()
  await expect(page.getByRole('textbox', { name: 'Rename group New group' })).toBeFocused()
  await page.keyboard.type(title)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('region', { name: title })).toBeVisible()
}

/** Saves Settings › Reduce motion the way the inspector does (storage:save → every window). */
async function setReduceMotion(page: Page, on: boolean): Promise<void> {
  const result = await page.evaluate(async (reduceMotion) => {
    const api = (globalThis as unknown as Api).taskyard
    const { revision, data } = await api.storage.load('settings')
    return api.storage.save('settings', { baseRevision: revision, data: { ...data, reduceMotion } })
  }, on)
  expect(result.ok).toBe(true)
}

/** The group's computed transition and entrance/hover state, as Chromium resolves them. */
function motionOf(page: Page, title: string): Promise<{ duration: string; opacity: string }> {
  return page.getByRole('region', { name: title }).evaluate((element) => {
    const style = getComputedStyle(element)
    return { duration: style.transitionDuration, opacity: style.opacity }
  })
}

test('keyboard: Shift+F10 and the menu key open exactly one menu for the focused thing', async () => {
  const profile: Profile = createProfile()
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ ...defaultSettings(), firstRunDone: true })
  )
  let app: ElectronApplication | undefined
  try {
    app = await launchTaskyard(profile)
    const page = await primaryWindow(app)
    await newGroup(page, 'Work')

    // The desktop surface is a Tab stop; its menu opens at its centre.
    await page.getByRole('application', { name: 'Desktop' }).focus()
    await page.keyboard.press('Shift+F10')
    await expect(page.getByRole('menu')).toHaveCount(1)
    await expect(page.getByRole('menuitem', { name: 'New group here' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)

    // A group's title-bar button: that group's menu, once (Chromium's own keyboard
    // contextmenu must not open a second one).
    const work = page.getByRole('region', { name: 'Work' })
    await work.getByRole('button', { name: 'Roll up' }).focus()
    await page.keyboard.press('ContextMenu')
    await expect(page.getByRole('menu')).toHaveCount(1)
    await expect(page.getByRole('menuitem', { name: 'Roll up' })).toBeVisible()
    await page.keyboard.press('Escape')

    // Tab reaches the group's controls with a visible focus ring.
    await work.getByRole('button', { name: 'Roll up' }).focus()
    await page.keyboard.press('Tab')
    const focused = page.locator(':focus-visible')
    await expect(focused).toHaveAttribute('aria-label', 'Group options')
    const ring = await focused.evaluate((el) => getComputedStyle(el).boxShadow)
    expect(ring).not.toBe('none')
  } finally {
    await app?.close()
    profile.dispose()
  }
})

test('motion: the settings kill switch and Windows reduced motion strip every transition', async () => {
  const profile: Profile = createProfile()
  writeFileSync(
    join(profile.userData, 'settings.json'),
    JSON.stringify({ ...defaultSettings(), firstRunDone: true })
  )
  let app: ElectronApplication | undefined
  try {
    app = await launchTaskyard(profile)
    const page = await primaryWindow(app)
    await newGroup(page, 'Work')

    // Motion on: settled groups carry their quick transitions (hover lift, roll-up height).
    await expect(page.getByRole('region', { name: 'Work' })).toHaveAttribute(
      'data-reveal',
      'settled'
    )
    expect((await motionOf(page, 'Work')).duration).not.toMatch(/^0s(, 0s)*$/)

    // Settings › Reduce motion (saved like the inspector does): everything drops to 0 s.
    await setReduceMotion(page, true)
    await expect(page.locator('html')).toHaveClass(/reduce-motion/)
    await expect.poll(async () => (await motionOf(page, 'Work')).duration).toMatch(/^0s(, 0s)*$/)
    expect((await motionOf(page, 'Work')).opacity).toBe('1')

    // Off again, then Windows' "Animation effects" off (prefers-reduced-motion) does the same.
    await setReduceMotion(page, false)
    await expect(page.locator('html')).not.toHaveClass(/reduce-motion/)
    await expect
      .poll(async () => (await motionOf(page, 'Work')).duration)
      .not.toMatch(/^0s(, 0s)*$/)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(async () => (await motionOf(page, 'Work')).duration).toMatch(/^0s(, 0s)*$/)
  } finally {
    await app?.close()
    profile.dispose()
  }
})
