import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { TaskyardApi } from '../src/preload/api'
import { writeLnk } from '../src/main/desktop/test/lnk-writer'
import { createProfile, launchTaskyard, primaryWindow, type Profile } from './helpers/taskyard'

const SYSTEM32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')

/** Width and height from a PNG data URL's IHDR chunk. */
function pngSize(dataUrl: string): { width: number; height: number } {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const tileIcon = (page: Page, name: string): Locator =>
  page.getByRole('option', { name, exact: true }).locator('img')

/** `ceil(64 × the largest scale factor over all displays)`, as main computes it. */
async function expectedPx(app: ElectronApplication): Promise<number> {
  const factors = await app.evaluate(({ screen }) =>
    screen.getAllDisplays().map((display) => display.scaleFactor)
  )
  return Math.ceil(64 * Math.max(1, ...factors))
}

function writeDesktop(profile: Profile): void {
  const desktop = profile.desktop
  writeFileSync(join(desktop, 'Notes.txt'), 'notes')
  mkdirSync(join(desktop, 'Projects'))
  writeFileSync(
    join(desktop, 'Notepad.lnk'),
    writeLnk({ localBasePath: join(SYSTEM32, 'notepad.exe') })
  )
  // A shortcut to a share that does not exist: never touched, so it shows the generic icon.
  writeFileSync(
    join(desktop, 'Share.lnk'),
    writeLnk({
      network: { netName: '\\\\taskyard-e2e-nowhere\\share' },
      commonPathSuffix: 'app.exe'
    })
  )
}

test('every item gets its icon: shortcut → target at the display size, folder → folder icon, network → generic', async () => {
  const profile = createProfile()
  writeDesktop(profile)

  let app = await launchTaskyard(profile)
  try {
    // New items are placed as loose icons on the primary display.
    const page = await primaryWindow(app)
    await expect(page.locator('main')).toHaveAttribute('data-desktop-items', '4')
    const px = await expectedPx(app)

    // The shortcut shows notepad's own icon (not Electron's blank .lnk page), extracted at px.
    await expect(tileIcon(page, 'Notepad')).toHaveAttribute('data-icon', String(px))
    await expect(tileIcon(page, 'Projects')).toHaveAttribute('data-icon', String(px))
    await expect(tileIcon(page, 'Notes')).toHaveAttribute('data-icon', '32')
    await expect(tileIcon(page, 'Share')).toHaveAttribute('data-icon', 'generic')

    // A real PNG of the requested size came through nativeImage (premultiplied BGRA → PNG).
    const src = await tileIcon(page, 'Notepad').getAttribute('src')
    expect(pngSize(src!)).toEqual({ width: px, height: px })
    // 48 CSS px on screen, drawn from px physical pixels (96 at 150 %: sharp).
    const box = await tileIcon(page, 'Notepad').boundingBox()
    expect(box).toMatchObject({ width: 48, height: 48 })

    // A window that asks later gets the same icons (desktop:icons).
    const pulled = await page.evaluate(() =>
      (globalThis as unknown as { taskyard: TaskyardApi }).taskyard.desktop.icons()
    )
    expect(pulled.map((icon) => icon.px).sort((a, b) => a - b)).toEqual([32, px, px])

    await expect.poll(() => profile.readLog()).toMatch(/icons: boot pass \d+ ms/)
    const log = profile.readLog()
    expect(log).toMatch(
      new RegExp(
        `icons: boot pass \\d+ ms at ${px} px \\(0 cached, 2 from Electron, 2 extracted, 1 generic, 0 failed\\)`
      )
    )
    expect(log).not.toMatch(/has no icon/)
    expect(readdirSync(join(profile.userData, 'icons')).sort()).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^[0-9a-f]{40}@${px}\\.png$`))])
    )
    expect(readdirSync(join(profile.userData, 'icons'))).toHaveLength(4) // 2 × 32 px, 2 × px
  } finally {
    await app.close()
  }

  // Second launch: every icon comes from the disk cache; nothing is fetched or extracted.
  app = await launchTaskyard(profile)
  try {
    const page = await primaryWindow(app)
    const px = await expectedPx(app)
    await expect(tileIcon(page, 'Notepad')).toHaveAttribute('data-icon', String(px))
    await expect(tileIcon(page, 'Notes')).toHaveAttribute('data-icon', '32')
    await expect.poll(() => profile.readLog().match(/icons: boot pass/g)?.length ?? 0).toBe(2)
    expect(profile.readLog()).toMatch(
      new RegExp(
        `icons: boot pass \\d+ ms at ${px} px \\(3 cached, 0 from Electron, 0 extracted, 1 generic, 0 failed\\)`
      )
    )
  } finally {
    await app.close()
    profile.dispose()
  }
})
