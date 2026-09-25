import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { LayoutFile } from '../src/shared/schema'
import { createProfile, launchTaskyard, primaryWindow, type Profile } from './helpers/taskyard'

// Phase 8 — drag and drop. Everything runs against temp desktop folders (TASKYARD_DESKTOP_DIRS)
// and a temp profile; the real Desktop is never read or changed.

function savedGroups(profile: Profile): LayoutFile['displays'][number]['groups'] {
  try {
    const layout = JSON.parse(
      readFileSync(join(profile.userData, 'layout.json'), 'utf8')
    ) as LayoutFile
    return layout.displays.flatMap((display) => display.groups)
  } catch {
    return [] // not written yet (or mid-write)
  }
}

/** The file id Taskyard keys the layout by (`dev:ino`, as main's scanner reads it). */
function fileId(path: string): string {
  const stats = statSync(path, { bigint: true })
  return `${stats.dev}:${stats.ino}`
}

async function center(locator: Locator): Promise<{ x: number; y: number }> {
  const rect = await locator.boundingBox()
  expect(rect).not.toBeNull()
  return { x: rect!.x + rect!.width / 2, y: rect!.y + rect!.height / 2 }
}

/** A right-button drag around the first two loose icons makes a group of them; named `title`. */
async function groupFirstTwoIcons(page: Page, title: string): Promise<Locator> {
  const first = await page.getByRole('option').first().boundingBox()
  expect(first).not.toBeNull()
  await page.mouse.move(first!.x + first!.width + 40, 8)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(4, first!.y + first!.height * 2 - 20, { steps: 8 })
  await page.mouse.up({ button: 'right' })
  await expect(page.getByRole('textbox', { name: 'Rename group New group' })).toBeFocused()
  await page.keyboard.type(title)
  await page.keyboard.press('Enter')
  return page.getByRole('region', { name: title })
}

async function newGroupAt(page: Page, x: number, y: number, title: string): Promise<Locator> {
  await page.mouse.click(x, y, { button: 'right' })
  await page.getByRole('menuitem', { name: 'New group here' }).click()
  await expect(page.getByRole('textbox', { name: 'Rename group New group' })).toBeFocused()
  await page.keyboard.type(title)
  await page.keyboard.press('Enter')
  return page.getByRole('region', { name: title })
}

test('drag an icon from group A to group B with the mouse → restart → it is still in B', async () => {
  const profile = createProfile()
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    writeFileSync(join(profile.desktop, `${name}.txt`), name)
  }
  const alphaId = fileId(join(profile.desktop, 'Alpha.txt'))
  let app: ElectronApplication | undefined
  try {
    app = await launchTaskyard(profile)
    let page = await primaryWindow(app)
    await expect(page.getByRole('option', { name: 'Alpha', exact: true })).toBeVisible()

    const a = await groupFirstTwoIcons(page, 'A')
    await expect(a.getByRole('option')).toHaveText(['Alpha', 'Beta'])
    const b = await newGroupAt(page, 900, 300, 'B')
    await expect(b.getByText('Drop icons here')).toBeVisible()

    // Press on Alpha, move past the 6 px threshold, carry it over B's body, release.
    const from = await center(a.getByRole('option', { name: 'Alpha' }))
    const to = await center(b.getByText('Drop icons here'))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 10, from.y + 4, { steps: 3 })
    // The stacked preview follows the pointer, outside every glass box.
    await expect(page.locator('[data-drag-overlay]')).toBeVisible()
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await expect(b).toHaveAttribute('data-drop-target')
    await page.mouse.up()

    await expect(b.getByRole('option')).toHaveText(['Alpha'])
    await expect(a.getByRole('option')).toHaveText(['Beta'])
    await expect(page.locator('[data-drag-overlay]')).toHaveCount(0)
    // Saved (debounced atomic write in main).
    await expect
      .poll(() => savedGroups(profile).find((group) => group.title === 'B')?.items)
      .toEqual([alphaId])

    await app.close()
    app = await launchTaskyard(profile)
    page = await primaryWindow(app)
    const bAgain = page.getByRole('region', { name: 'B' })
    await expect(bAgain.getByRole('option')).toHaveText(['Alpha'])
    await expect(page.getByRole('region', { name: 'A' }).getByRole('option')).toHaveText(['Beta'])
  } finally {
    await app?.close()
    profile.dispose()
  }
})

test('an Explorer drop moves the file into the Desktop at the drop point; Undo moves it back', async () => {
  const profile = createProfile()
  writeFileSync(join(profile.desktop, 'Notes.txt'), 'notes')
  // The "Explorer" folder the file is dragged from: another temp folder.
  const elsewhere = mkdtempSync(join(tmpdir(), 'taskyard-e2e-source-'))
  const source = join(elsewhere, 'Report.txt')
  writeFileSync(source, 'report')
  const moved = join(profile.desktop, 'Report.txt')
  let app: ElectronApplication | undefined
  try {
    app = await launchTaskyard(profile)
    const page = await primaryWindow(app)
    await expect(page.getByRole('option', { name: 'Notes', exact: true })).toBeVisible()

    // A real OS-level file drag, as Explorer starts one: Chromium's input pipeline hands the page
    // File objects backed by these paths (webUtils.getPathForFile resolves them).
    const cdp = await page.context().newCDPSession(page)
    const data = { items: [], files: [source], dragOperationsMask: 1 | 2 | 16 }
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await cdp.send('Input.dispatchDragEvent', { type, x: 500, y: 500, data })
    }

    const report = page.getByRole('option', { name: 'Report', exact: true })
    await expect(report).toBeVisible()
    await expect.poll(() => existsSync(moved)).toBe(true)
    expect(existsSync(source)).toBe(false)
    // The cell nearest the drop point (96 px grid at 100 %: column 5, row 5 → 480, 480).
    const rect = await report.boundingBox()
    expect(rect).toMatchObject({ x: 480, y: 480 })
    await expect(page.getByText('Moved 1 item to the Desktop')).toBeVisible()

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => existsSync(source)).toBe(true)
    expect(existsSync(moved)).toBe(false)
    await expect(report).toHaveCount(0)
  } finally {
    await app?.close()
    profile.dispose()
    rmSync(elsewhere, { recursive: true, force: true })
  }
})

test('a file dropped on the Undo toast (outside the canvas) is swallowed: nothing moves, the window stays Taskyard', async () => {
  const profile = createProfile()
  writeFileSync(join(profile.desktop, 'Notes.txt'), 'notes')
  const elsewhere = mkdtempSync(join(tmpdir(), 'taskyard-e2e-source-'))
  const first = join(elsewhere, 'First.txt')
  const second = join(elsewhere, 'Second.txt')
  writeFileSync(first, 'first')
  writeFileSync(second, 'second')
  let app: ElectronApplication | undefined
  try {
    app = await launchTaskyard(profile)
    const page = await primaryWindow(app)
    const url = page.url()
    await expect(page.getByRole('option', { name: 'Notes', exact: true })).toBeVisible()
    const cdp = await page.context().newCDPSession(page)
    const drag = async (file: string, x: number, y: number): Promise<void> => {
      const data = { items: [], files: [file], dragOperationsMask: 1 | 2 | 16 }
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        await cdp.send('Input.dispatchDragEvent', { type, x, y, data })
      }
    }

    // A first drop on the canvas brings up the Undo toast (pointer-events: auto, above it).
    await drag(first, 500, 500)
    const undo = page.getByRole('button', { name: 'Undo' })
    await expect(undo).toBeVisible()

    const target = await center(undo)
    await drag(second, target.x, target.y)
    await page.waitForTimeout(500)

    expect(page.url()).toBe(url)
    expect(existsSync(second)).toBe(true)
    expect(existsSync(join(profile.desktop, 'Second.txt'))).toBe(false)
    await expect(page.getByRole('option', { name: 'Second', exact: true })).toHaveCount(0)

    // A navigation the page itself starts is refused by main as well.
    await page.evaluate(() => {
      window.location.href = 'https://example.com/'
    })
    await page.waitForTimeout(500)
    expect(page.url()).toBe(url)
    // Still alive: IPC works (the sender guard accepts the page).
    const names = await page.evaluate(async () =>
      (await window.taskyard.desktop.list()).map((item) => item.name).sort()
    )
    expect(names).toEqual(['First', 'Notes'])
  } finally {
    await app?.close()
    profile.dispose()
    rmSync(elsewhere, { recursive: true, force: true })
  }
})
