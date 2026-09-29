import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { LayoutFile, SettingsFile } from '../src/shared/schema'
import { createProfile, launchTaskyard, primaryWindow, type Profile } from './helpers/taskyard'

// Round 2 (user testing): group interactions driven by the real mouse — the chevron, reordering
// inside a group, the group menu's submenus, snapping, rolling down near the screen's bottom.
// Temp desktop folder and profile only.

function readJson<T>(profile: Profile, file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(join(profile.userData, file), 'utf8')) as T
  } catch {
    return undefined // not written yet (or mid-write)
  }
}

function savedGroups(profile: Profile): LayoutFile['displays'][number]['groups'] {
  return (readJson<LayoutFile>(profile, 'layout.json')?.displays ?? []).flatMap(
    (display) => display.groups
  )
}

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const rect = await locator.boundingBox()
  expect(rect).not.toBeNull()
  return { x: rect!.x + rect!.width / 2, y: rect!.y + rect!.height / 2 }
}

/** The layout rect (CSS left/top/size), not the bounding box the hover lift moves. */
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

async function layoutHeight(locator: Locator): Promise<number> {
  return (await box(locator)).height
}

/** True when a real click at the locator's centre reaches it (nothing clips or covers it). */
async function hittable(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return hit !== null && element.contains(hit)
  })
}

/** A press, a move past the drag threshold, a glide to `to` and — unless `hold` — a release. */
async function mouseDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  hold = false
): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 10, from.y + 4, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  if (!hold) await page.mouse.up()
}

/** A right-button drag around the first `count` loose icons makes a group of them. */
async function groupLooseIcons(page: Page, title: string, count: number): Promise<Locator> {
  const first = await page.getByRole('option').first().boundingBox()
  expect(first).not.toBeNull()
  await page.mouse.move(first!.x + first!.width + 40, 8)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(4, first!.y + first!.height * count + 10, { steps: 8 })
  await page.mouse.up({ button: 'right' })
  await expect(page.getByRole('textbox', { name: 'Rename group New group' })).toBeFocused()
  await page.keyboard.type(title)
  await page.keyboard.press('Enter')
  return page.getByRole('region', { name: title, exact: true })
}

async function newGroupAt(page: Page, x: number, y: number, title: string): Promise<Locator> {
  await page.mouse.click(x, y, { button: 'right' })
  await page.getByRole('menuitem', { name: 'New group here' }).click()
  await expect(page.getByRole('textbox', { name: 'Rename group New group' })).toBeFocused()
  // The menu fades out over the new group; wait until it is gone before pressing there.
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.keyboard.type(title)
  await page.keyboard.press('Enter')
  return page.getByRole('region', { name: title, exact: true })
}

async function launchWith(
  profile: Profile,
  names: readonly string[],
  { organize = false }: { organize?: boolean } = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  for (const name of names) writeFileSync(join(profile.desktop, `${name}.txt`), name)
  const app = await launchTaskyard(profile)
  const page = await primaryWindow(app)
  for (const name of names) {
    await expect(page.getByRole('option', { name, exact: true })).toBeVisible()
  }
  // The first-run card (Phase 11): auto-organize by type (groups sorted by name), or keep as is.
  const button = organize ? /^Organize \d+ icons? by type$/ : 'Keep my desktop as it is'
  await page.getByRole('button', { name: button }).click()
  return { app, page }
}

test('one click on the chevron rolls a group up and one more rolls it down, even when another group is on top', async () => {
  const profile = createProfile()
  let app: ElectronApplication | undefined
  try {
    const launched = await launchWith(profile, ['Alpha', 'Beta'])
    app = launched.app
    const page = launched.page
    const a = await groupLooseIcons(page, 'A', 2)
    const b = await newGroupAt(page, 900, 300, 'B')
    await expect(b).toBeVisible()
    const full = await layoutHeight(a)

    // B was made last, so it is on top; A's chevron is pressed with the real mouse.
    const chevron = await center(a.getByRole('button', { name: 'Roll up' }))
    await page.mouse.move(chevron.x, chevron.y)
    await page.mouse.click(chevron.x, chevron.y)
    await expect(a).toHaveAttribute('data-rolled-up', 'true')
    await expect.poll(() => layoutHeight(a)).toBe(36)

    // B takes the top again, then a single click on the same spot rolls A down.
    const bTitle = await center(b.getByRole('heading', { name: 'B' }))
    await page.mouse.click(bTitle.x, bTitle.y)
    await page.mouse.move(chevron.x, chevron.y)
    await page.mouse.click(chevron.x, chevron.y)
    await expect(a).not.toHaveAttribute('data-rolled-up')
    await expect.poll(() => layoutHeight(a)).toBe(full)

    // And straight away once more each way, without moving.
    await page.mouse.click(chevron.x, chevron.y)
    await expect(a).toHaveAttribute('data-rolled-up', 'true')
    await page.mouse.click(chevron.x, chevron.y)
    await expect(a).not.toHaveAttribute('data-rolled-up')

    // A double-click on the title still toggles.
    await a.getByRole('heading', { name: 'A' }).dblclick()
    await expect(a).toHaveAttribute('data-rolled-up', 'true')
  } finally {
    await app?.close()
    profile.dispose()
  }
})

test('dragging an icon to another spot in its group reorders it — a sorted group turns manual and keeps the drop order', async () => {
  const profile = createProfile()
  let app: ElectronApplication | undefined
  try {
    const launched = await launchWith(profile, ['Alpha', 'Beta', 'Gamma'], { organize: true })
    app = launched.app
    const page = launched.page
    // Auto-organize made "Files", sorted by name.
    const files = page.getByRole('region', { name: 'Files', exact: true })
    await expect(files.getByRole('option')).toHaveText(['Alpha', 'Beta', 'Gamma'])
    await expect.poll(() => savedGroups(profile)[0]?.sort).toBe('name')

    // Alpha → past the middle of Gamma: the insert bar shows, and Alpha lands last.
    const from = await center(files.getByRole('option', { name: 'Alpha' }))
    const gamma = (await files.getByRole('option', { name: 'Gamma' }).boundingBox())!
    const past = { x: gamma.x + gamma.width * 0.8, y: gamma.y + gamma.height / 2 }
    await mouseDrag(page, from, past, true)
    await expect(files.locator('[data-drop-indicator]')).toBeVisible()
    await page.mouse.up()
    await expect(files.getByRole('option')).toHaveText(['Beta', 'Gamma', 'Alpha'])
    await expect.poll(() => savedGroups(profile)[0]?.sort).toBe('manual')

    // Again with another group made later (so Files is not on top when pressed): Gamma first.
    const other = await newGroupAt(page, 1200, 700, 'Other')
    await expect(other).toBeVisible()
    const gammaAt = await center(files.getByRole('option', { name: 'Gamma' }))
    const beta = (await files.getByRole('option', { name: 'Beta' }).boundingBox())!
    await mouseDrag(page, gammaAt, { x: beta.x + beta.width * 0.2, y: beta.y + beta.height / 2 })
    await expect(files.getByRole('option')).toHaveText(['Gamma', 'Beta', 'Alpha'])

    // The order survives a restart.
    await expect
      .poll(() => savedGroups(profile).find((group) => group.title === 'Files')?.items.length)
      .toBe(3)
    await page.waitForTimeout(600)
    await app.close()
    app = await launchTaskyard(profile)
    const again = await primaryWindow(app)
    await expect(
      again.getByRole('region', { name: 'Files', exact: true }).getByRole('option')
    ).toHaveText(['Gamma', 'Beta', 'Alpha'])
  } finally {
    await app?.close()
    profile.dispose()
  }
})

test('the group menu’s submenus open on hover, on click and with →, visible and clickable', async () => {
  const profile = createProfile()
  let app: ElectronApplication | undefined
  try {
    const launched = await launchWith(profile, ['Alpha', 'Beta'])
    app = launched.app
    const page = launched.page
    const a = await groupLooseIcons(page, 'A', 2)
    const options = await center(a.getByRole('button', { name: 'Group options' }))

    // Hover "Sort by" with the mouse, then click "Name" where it is drawn.
    await page.mouse.click(options.x, options.y)
    const sortBy = await center(page.getByRole('menuitem', { name: 'Sort by' }))
    await page.mouse.move(sortBy.x - 40, sortBy.y)
    await page.mouse.move(sortBy.x, sortBy.y, { steps: 4 })
    const name = page.getByRole('menuitemradio', { name: 'Name' })
    await expect(name).toBeVisible()
    await expect.poll(() => hittable(name)).toBe(true)
    const nameAt = await center(name)
    await page.mouse.move(nameAt.x, sortBy.y, { steps: 6 })
    await page.mouse.move(nameAt.x, nameAt.y, { steps: 4 })
    await page.mouse.click(nameAt.x, nameAt.y)
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect.poll(() => savedGroups(profile)[0]?.sort).toBe('name')

    // Click "Icon size": the submenu opens and "Large" can be clicked.
    await page.mouse.click(options.x, options.y)
    const iconSize = await center(page.getByRole('menuitem', { name: 'Icon size' }))
    await page.mouse.click(iconSize.x, iconSize.y)
    const large = page.getByRole('menuitemradio', { name: 'Large' })
    await expect.poll(() => hittable(large)).toBe(true)
    const largeAt = await center(large)
    await page.mouse.move(largeAt.x, iconSize.y, { steps: 6 })
    await page.mouse.move(largeAt.x, largeAt.y, { steps: 4 })
    await page.mouse.click(largeAt.x, largeAt.y)
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect
      .poll(() => readJson<SettingsFile>(profile, 'settings.json')?.iconSize)
      .toBe('large')

    // Keyboard: → on "Move to display" opens it with the focus inside.
    const optionsNow = await center(a.getByRole('button', { name: 'Group options' }))
    await page.mouse.click(optionsNow.x, optionsNow.y)
    const moveTo = page.getByRole('menuitem', { name: 'Move to display' })
    for (let i = 0; i < 8; i++) {
      if (await moveTo.evaluate((item) => item === document.activeElement)) break
      await page.keyboard.press('ArrowDown')
    }
    await expect(moveTo).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('menu')).toHaveCount(2)
    const submenu = page.getByRole('menu').nth(1)
    await expect
      .poll(() => submenu.evaluate((menu) => menu.contains(document.activeElement)))
      .toBe(true)
    await expect.poll(() => hittable(submenu.getByRole('menuitem').first())).toBe(true)
    await page.keyboard.press('Escape')
  } finally {
    await app?.close()
    profile.dispose()
  }
})

test('moving a group next to another snaps it flush, with a guide line; Alt places it freely', async () => {
  const profile = createProfile()
  let app: ElectronApplication | undefined
  try {
    const launched = await launchWith(profile, ['Alpha'])
    app = launched.app
    const page = launched.page
    const still = await newGroupAt(page, 800, 400, 'Still')
    const moving = await newGroupAt(page, 800, 800, 'Moving')
    const s = await box(still)
    const m = await box(moving)
    const title = await center(moving.getByRole('heading', { name: 'Moving' }))

    // Left edge 5 px right of Still's right edge, top 3 px below Still's top: pulled flush.
    const to = { x: title.x + (s.x + s.width + 5 - m.x), y: title.y + (s.y + 3 - m.y) }
    await mouseDrag(page, title, to, true)
    await expect(page.locator('[data-snap-guide]').first()).toBeVisible()
    await page.mouse.up()
    await expect(page.locator('[data-snap-guide]')).toHaveCount(0)
    await expect.poll(() => box(moving)).toMatchObject({ x: s.x + s.width, y: s.y })

    // Alt held: exactly where it is dropped, off the grid.
    const now = await center(moving.getByRole('heading', { name: 'Moving' }))
    await page.keyboard.down('Alt')
    await mouseDrag(page, now, { x: now.x + 3, y: now.y + 205 })
    await page.keyboard.up('Alt')
    await expect.poll(() => box(moving)).toMatchObject({ x: s.x + s.width + 3, y: s.y + 205 })
  } finally {
    await app?.close()
    profile.dispose()
  }
})

test('a rolled-up group at the bottom of the screen rolls down upward, on top of its neighbour', async () => {
  const profile = createProfile()
  let app: ElectronApplication | undefined
  try {
    const launched = await launchWith(profile, ['Alpha'])
    app = launched.app
    const page = launched.page
    const low = await newGroupAt(page, 400, 300, 'Low')
    const full = await box(low)
    await low.getByRole('button', { name: 'Roll up' }).click()
    await expect.poll(() => layoutHeight(low)).toBe(36)

    // Drag the bar far below the screen: only the bar has to stay inside the work area.
    const title = await center(low.getByRole('heading', { name: 'Low' }))
    const bottom = await page.evaluate(() => window.innerHeight)
    await mouseDrag(page, title, { x: title.x, y: bottom + 400 })
    const rolled = await box(low)
    expect(rolled.y + 36).toBeGreaterThan(bottom - 100)

    // A neighbour made later sits on top, just above it.
    const over = await newGroupAt(page, 400, rolled.y - 220, 'Over')
    await expect(over).toBeVisible()

    const chevron = await center(low.getByRole('button', { name: 'Roll down' }))
    await page.mouse.move(chevron.x, chevron.y)
    await page.mouse.click(chevron.x, chevron.y)
    await expect(low).not.toHaveAttribute('data-rolled-up')
    // Grown upward to its full height, still inside the work area, and above Over.
    await expect.poll(() => layoutHeight(low)).toBe(full.height)
    const expanded = await box(low)
    expect(expanded.y).toBeLessThan(rolled.y)
    expect(expanded.y + expanded.height).toBeLessThanOrEqual(rolled.y + 36)
    const z = async (locator: Locator): Promise<number> =>
      Number(await locator.evaluate((element) => getComputedStyle(element).zIndex))
    expect(await z(low)).toBeGreaterThan(await z(over))
    await expect
      .poll(() => savedGroups(profile).find((group) => group.title === 'Low'))
      .toMatchObject({ rolledUp: false, y: expanded.y, h: full.height })
  } finally {
    await app?.close()
    profile.dispose()
  }
})
