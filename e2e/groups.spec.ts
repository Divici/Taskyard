import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { LayoutFile } from '../src/shared/schema'
import { createProfile, launchTaskyard, primaryWindow, type Profile } from './helpers/taskyard'

// Everything runs against a temp desktop folder (TASKYARD_DESKTOP_DIRS) and a temp profile.

function savedLayout(profile: Profile): LayoutFile {
  return JSON.parse(readFileSync(join(profile.userData, 'layout.json'), 'utf8')) as LayoutFile
}

function savedGroups(profile: Profile): LayoutFile['displays'][number]['groups'] {
  try {
    return savedLayout(profile).displays.flatMap((display) => display.groups)
  } catch {
    return [] // not written yet (or mid-write)
  }
}

/**
 * A group's layout rect (CSS left/top/size in the canvas): what the layout stores. Not the
 * bounding box, which the Phase 12 hover lift (2 px) and launch entrance move on screen.
 */
async function box(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  return locator.evaluate((element: HTMLElement) => ({
    x: element.offsetLeft,
    y: element.offsetTop,
    width: element.offsetWidth,
    height: element.offsetHeight
  }))
}

/** Where a locator is on screen right now (for the pointer). */
async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const rect = (await locator.boundingBox())!
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

test('a group: create → rename → resize → roll up → restart → it is all still there', async () => {
  const profile = createProfile()
  writeFileSync(join(profile.desktop, 'Notes.txt'), 'notes')
  writeFileSync(join(profile.desktop, 'Plan.txt'), 'plan')
  let app: ElectronApplication | undefined
  try {
    app = await launchTaskyard(profile)
    let page: Page = await primaryWindow(app)
    // The two files were placed as loose icons (reconcile, primary window).
    await expect(page.getByRole('option', { name: 'Notes', exact: true })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Plan', exact: true })).toBeVisible()

    // Create: desktop menu → New group here, at the click point, 280 × 200, rename open.
    await page.mouse.click(600, 400, { button: 'right' })
    await page.getByRole('menuitem', { name: 'New group here' }).click()
    const rename = page.getByRole('textbox', { name: 'Rename group New group' })
    await expect(rename).toBeFocused()

    // Rename.
    await page.keyboard.type('Work')
    await page.keyboard.press('Enter')
    const group = page.getByRole('region', { name: 'Work' })
    await expect(group).toBeVisible()
    expect(await box(group)).toEqual({ x: 600, y: 400, width: 280, height: 200 })
    await expect(group.getByText('Drop icons here')).toBeVisible()

    // Resize from the bottom-right handle: +104, +56 (on the 8 px grid).
    const handle = await center(group.locator('[data-resize-edge="se"]'))
    await page.mouse.move(handle.x, handle.y)
    await page.mouse.down()
    await page.mouse.move(handle.x + 52, handle.y + 28, { steps: 4 })
    await page.mouse.move(handle.x + 104, handle.y + 56, { steps: 4 })
    await page.mouse.up()
    await expect.poll(async () => box(group)).toEqual({ x: 600, y: 400, width: 384, height: 256 })

    // Roll up: double-click the title; only the 36 px header is left, the width is kept.
    await group.getByRole('heading', { name: 'Work' }).dblclick()
    await expect.poll(async () => box(group)).toEqual({ x: 600, y: 400, width: 384, height: 36 })
    await expect(group.getByRole('button', { name: 'Roll down' })).toBeVisible()

    // Saved (debounced atomic write in main).
    await expect
      .poll(() => savedGroups(profile))
      .toEqual([
        expect.objectContaining({ title: 'Work', x: 600, y: 400, w: 384, h: 256, rolledUp: true })
      ])

    // Restart: the same group, rolled up, where it was.
    await app.close()
    app = await launchTaskyard(profile)
    page = await primaryWindow(app)
    const again = page.getByRole('region', { name: 'Work' })
    await expect(again).toBeVisible()
    await expect.poll(async () => box(again)).toEqual({ x: 600, y: 400, width: 384, height: 36 })
    await again.getByRole('button', { name: 'Roll down' }).click()
    await expect.poll(async () => box(again)).toEqual({ x: 600, y: 400, width: 384, height: 256 })
  } finally {
    await app?.close()
    profile.dispose()
  }
})

test('a right-button drag on the desktop draws a group around the icons (no menu opens)', async () => {
  const profile = createProfile()
  writeFileSync(join(profile.desktop, 'Notes.txt'), 'notes')
  writeFileSync(join(profile.desktop, 'Plan.txt'), 'plan')
  let app: ElectronApplication | undefined
  try {
    app = await launchTaskyard(profile)
    const page = await primaryWindow(app)
    const notes = page.getByRole('option', { name: 'Notes', exact: true })
    await expect(notes).toBeVisible()
    // The first-run card (Phase 11) sits mid-screen, where the second drag below happens.
    await page.getByRole('button', { name: 'Keep my desktop as it is' }).click()
    const icon = (await notes.boundingBox())!

    // From above-left of the first column to below the second icon.
    const start = { x: icon.x + icon.width + 40, y: 8 }
    const end = { x: 4, y: icon.y + icon.height * 2 + 30 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(end.x, end.y, { steps: 8 })
    await page.mouse.up({ button: 'right' })

    const group = page.getByRole('region', { name: 'New group' })
    await expect(group).toBeVisible()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(group.getByRole('textbox', { name: 'Rename group New group' })).toBeFocused()
    await page.keyboard.type('Icons')
    await page.keyboard.press('Enter')
    const icons = page.getByRole('region', { name: 'Icons' })
    await expect(icons.getByRole('option')).toHaveText(['Notes', 'Plan'])
    await expect(page.getByRole('listbox', { name: 'Desktop icons' })).toHaveCount(0)

    // A small up-left right-drag in empty space: the group grows to 160 × 120 from the band's
    // top-left, so the button comes up *inside* the new group. Still no menu anywhere, and the
    // rename field keeps the focus.
    await page.mouse.move(1240, 840)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(1200, 800, { steps: 6 })
    await page.mouse.up({ button: 'right' })
    const second = page.getByRole('region', { name: 'New group' })
    await expect(second).toBeVisible()
    expect(await box(second)).toEqual({ x: 1200, y: 800, width: 160, height: 120 })
    await page.waitForTimeout(200)
    await expect(page.getByRole('menu')).toHaveCount(0)
    const rename = second.getByRole('textbox', { name: 'Rename group New group' })
    await expect(rename).toBeFocused()
    await page.keyboard.type('Later')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('region', { name: 'Later' })).toBeVisible()

    // The next real right-click on the desktop opens the desktop menu.
    await page.mouse.click(1800, 400, { button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'New group here' })).toBeVisible()
    await page.keyboard.press('Escape')
  } finally {
    await app?.close()
    profile.dispose()
  }
})
