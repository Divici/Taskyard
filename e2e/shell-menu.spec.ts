import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { LayoutFile, SettingsFile } from '../src/shared/schema'
import type { ShellMenuScriptStep } from '../src/main/shell-menu/scripted-shell-menu'
import type { TaskyardApi } from '../src/preload/api'
import { createProfile, launchTaskyard, primaryWindow, type Profile } from './helpers/taskyard'

// Native menus, Phase 3: the empty desktop's right-click shows the real Windows desktop menu.
// Here the shell-menu helper is the scripted fake (TASKYARD_FAKE_SHELL_MENU=1): the real host,
// helper core, IPC, placement and fallback run, but no Windows menu ever appears. Each step says
// what the "user" does in the next menu. Temp profile and temp desktop folder only.

interface ScriptControl {
  script(...steps: ShellMenuScriptStep[]): void
  shown: { point: { x: number; y: number }; extendedVerbs: boolean; target: { kind: string } }[]
  invoked: (string | null)[]
}
type MainGlobal = typeof globalThis & { __taskyardShellMenu: ScriptControl }

async function script(app: ElectronApplication, ...steps: ShellMenuScriptStep[]): Promise<void> {
  await app.evaluate((_electron, list) => {
    ;(globalThis as MainGlobal).__taskyardShellMenu.script(...list)
  }, steps)
}

async function shown(app: ElectronApplication): Promise<ScriptControl['shown']> {
  return app.evaluate(() => structuredClone((globalThis as MainGlobal).__taskyardShellMenu.shown))
}

function savedSettings(profile: Profile): SettingsFile | null {
  try {
    return JSON.parse(readFileSync(join(profile.userData, 'settings.json'), 'utf8')) as SettingsFile
  } catch {
    return null // not written yet (or mid-write)
  }
}

function savedLayout(profile: Profile): LayoutFile | null {
  try {
    return JSON.parse(readFileSync(join(profile.userData, 'layout.json'), 'utf8')) as LayoutFile
  } catch {
    return null
  }
}

async function launch(profile: Profile): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchTaskyard(profile, { shellMenu: 'scripted' })
  const page = await primaryWindow(app)
  await expect(page.locator('[data-canvas-surface]')).toBeVisible()
  // The window asked main whether native menus can show before the first right-click counts.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (globalThis as unknown as { taskyard: TaskyardApi }).taskyard.shellMenu.available()
      )
    )
    .toBe(true)
  return { app, page }
}

test.describe('native desktop menu (scripted helper)', () => {
  let profile: Profile
  let app: ElectronApplication | undefined

  test.beforeEach(() => {
    profile = createProfile()
  })
  test.afterEach(async () => {
    await app?.close()
    app = undefined
    profile.dispose()
  })

  test('right-click → Taskyard ▸ New group here runs, at the physical point of the click', async () => {
    const launched = await launch(profile)
    app = launched.app
    const { page } = launched
    await script(app, { choose: ['Taskyard', 'New group here'] })

    await page.mouse.click(608, 400, { button: 'right' })

    const rename = page.getByRole('textbox', { name: 'Rename group New group' })
    await expect(rename).toBeFocused()
    // No Taskyard (Radix) menu opened: the native one handled the click.
    await expect(page.getByRole('menu')).toHaveCount(0)
    const expected = await app.evaluate(({ screen }) => {
      const origin = screen.getPrimaryDisplay().bounds
      const point = screen.dipToScreenPoint({ x: origin.x + 608, y: origin.y + 400 })
      return { x: Math.round(point.x), y: Math.round(point.y) }
    })
    expect(await shown(app)).toEqual([
      { target: { kind: 'desktop-background' }, point: expected, extendedVerbs: false }
    ])
    await page.keyboard.type('Work')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('region', { name: 'Work' })).toBeVisible()
  })

  test('mapped items: View ▸ Small icons sets Taskyard’s icon size; Refresh rescans; Shift asks for extended verbs', async () => {
    const launched = await launch(profile)
    app = launched.app
    const { page } = launched
    await script(app, { choose: ['View', 'Small icons'] }, { choose: ['Refresh'] })

    await page.mouse.click(900, 300, { button: 'right' })
    await expect.poll(() => savedSettings(profile)?.iconSize, { timeout: 10_000 }).toBe('small')

    const scans = (): number => profile.readLog().split('scan: folder').length - 1
    const before = scans()
    await page.keyboard.down('Shift')
    await page.mouse.click(900, 300, { button: 'right' })
    await page.keyboard.up('Shift')
    await expect.poll(scans, { timeout: 10_000 }).toBeGreaterThan(before)
    expect((await shown(app)).map((entry) => entry.extendedVerbs)).toEqual([false, true])
  })

  test('New ▸ Folder: the new folder lands at the right-click point with inline rename open', async () => {
    const launched = await launch(profile)
    app = launched.app
    const { page } = launched
    await script(app, { choose: ['New', 'Folder'] })

    await page.mouse.click(700, 500, { button: 'right' })
    await expect
      .poll(() => app!.evaluate(() => (globalThis as MainGlobal).__taskyardShellMenu.invoked))
      .toEqual(['NewFolder'])
    // The scripted helper runs nothing in Windows: make the folder New ▸ Folder would have made.
    mkdirSync(join(profile.desktop, 'New folder'))

    const rename = page.getByRole('textbox', { name: 'Rename New folder' })
    await expect(rename).toBeFocused({ timeout: 10_000 })
    const icon = page.getByRole('option', { name: 'New folder', exact: true })
    // The medium loose cell is 96 × 96: the one nearest (700, 500) starts at (672, 480).
    await expect
      .poll(() =>
        icon.evaluate((element: HTMLElement) => ({
          x: element.offsetLeft,
          y: element.offsetTop
        }))
      )
      .toEqual({ x: 672, y: 480 })
    await page.keyboard.press('Escape')
    await expect
      .poll(() => {
        const layout = savedLayout(profile)
        return layout?.displays.flatMap((display) => Object.values(display.loose)) ?? []
      })
      .toContainEqual({ x: 672, y: 480 })
  })

  test('a failed Windows command shows a toast, and never Taskyard’s menu', async () => {
    const launched = await launch(profile)
    app = launched.app
    const { page } = launched
    await script(app, {
      choose: ['Open in Terminal'],
      failInvoke: 'The system cannot find the file specified.'
    })

    await page.mouse.click(700, 500, { button: 'right' })

    await expect(page.getByText('Windows couldn’t complete “Open in Terminal”.')).toBeVisible()
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('helper failure → Taskyard’s own menu opens at the same point; a crashed helper is replaced', async () => {
    const launched = await launch(profile)
    app = launched.app
    const { page } = launched
    await script(
      app,
      { fail: 'no foreground' },
      { crash: true },
      { choose: ['Taskyard', 'Sort loose icons'] }
    )

    // Fails before showing: the fallback menu at the click point, and its item works there.
    await page.mouse.click(608, 400, { button: 'right' })
    await page.getByRole('menuitem', { name: 'New group here' }).click()
    await expect(page.getByRole('textbox', { name: 'Rename group New group' })).toBeFocused()
    await page.keyboard.press('Enter')
    const group = page.getByRole('region', { name: 'New group' })
    expect(
      await group.evaluate((element: HTMLElement) => [element.offsetLeft, element.offsetTop])
    ).toEqual([608, 400])

    // The helper dies with the next menu: fallback again (dismissed with Escape).
    await page.mouse.click(1200, 900, { button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'New group here' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)

    // The next right-click gets a new helper: the native menu again (nothing falls back).
    await page.mouse.click(1200, 900, { button: 'right' })
    await expect.poll(async () => (await shown(app!)).length).toBe(1)
    await expect(page.getByRole('menu')).toHaveCount(0)
    const log = profile.readLog()
    expect(log).toContain("shell-menu: no native menu (request-failed); showing Taskyard's menu")
    expect(log).toContain("shell-menu: no native menu (helper-exited); showing Taskyard's menu")
  })
})

// Native menus, Phase 4: a right-click on icons shows Windows' file menu for them (scripted).
test.describe('native icon menus (scripted helper)', () => {
  let profile: Profile
  let app: ElectronApplication | undefined

  test.beforeEach(() => {
    profile = createProfile()
  })
  test.afterEach(async () => {
    await app?.close()
    app = undefined
    profile.dispose()
  })

  async function launchWith(...files: string[]): Promise<Page> {
    for (const name of files) writeFileSync(join(profile.desktop, name), name)
    const launched = await launch(profile)
    app = launched.app
    const { page } = launched
    await expect(
      page.getByRole('option', { name: files[0].replace(/\.txt$/, ''), exact: true })
    ).toBeVisible()
    // The first-run card (Phase 11) is not part of these checks.
    await page.getByRole('button', { name: 'Keep my desktop as it is' }).click()
    return page
  }

  const icon = (page: Page, name: string): ReturnType<Page['getByRole']> =>
    page.getByRole('option', { name, exact: true })

  test('right-click on an icon → Windows’ file menu for its path; Rename opens Taskyard’s inline rename', async () => {
    const page = await launchWith('Notes.txt')
    await script(app!, { choose: ['Rename'] })

    await icon(page, 'Notes').click({ button: 'right' })

    const rename = page.getByRole('textbox', { name: 'Rename Notes' })
    await expect(rename).toBeFocused()
    await expect(page.getByRole('menu')).toHaveCount(0)
    const [menu] = await shown(app!)
    expect(menu.target).toEqual({ kind: 'items', paths: [join(profile.desktop, 'Notes.txt')] })
    await page.keyboard.type('Journal')
    await page.keyboard.press('Enter')
    await expect(icon(page, 'Journal')).toBeVisible()
    expect(existsSync(join(profile.desktop, 'Journal.txt'))).toBe(true)
  })

  test('a selection in one folder gets one menu (right-clicked first); Delete runs in Windows', async () => {
    const page = await launchWith('Notes.txt', 'Plan.txt')
    await script(app!, { choose: ['Delete'] })

    await icon(page, 'Notes').click()
    await icon(page, 'Plan').click({ modifiers: ['Control'] })
    await icon(page, 'Plan').click({ button: 'right' })

    await expect
      .poll(() => app!.evaluate(() => (globalThis as MainGlobal).__taskyardShellMenu.invoked))
      .toEqual(['delete'])
    const [menu] = await shown(app!)
    expect(menu.target).toEqual({
      kind: 'items',
      paths: [join(profile.desktop, 'Plan.txt'), join(profile.desktop, 'Notes.txt')]
    })
    // Taskyard asked nothing itself (Windows' Delete has its own confirmation rules).
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('in a group: Remove from group (Taskyard’s item on top of Windows’ menu) makes the icon loose', async () => {
    const page = await launchWith('Notes.txt')
    const box = (await icon(page, 'Notes').boundingBox())!
    // A right-drag around the icon puts it in a new group (groups.spec).
    await page.mouse.move(box.x + box.width + 40, 8)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(4, box.y + box.height + 30, { steps: 8 })
    await page.mouse.up({ button: 'right' })
    await page.keyboard.press('Enter')
    const group = page.getByRole('region', { name: 'New group' })
    await expect(group.getByRole('option', { name: 'Notes' })).toBeVisible()

    await script(app!, { choose: ['Remove from group'] })
    await group.getByRole('option', { name: 'Notes' }).click({ button: 'right' })

    await expect(group.getByRole('option')).toHaveCount(0)
    await expect(
      page.getByRole('listbox', { name: 'Desktop icons' }).getByRole('option', { name: 'Notes' })
    ).toBeVisible()
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('a failed Windows command shows a toast; a helper failure opens Taskyard’s icon menu there', async () => {
    const page = await launchWith('Notes.txt')
    await script(
      app!,
      { choose: ['Properties'], failInvoke: 'Access is denied.' },
      { fail: 'no foreground' }
    )

    await icon(page, 'Notes').click({ button: 'right' })
    await expect(page.getByText('Windows couldn’t complete “Properties”.')).toBeVisible()
    await expect(page.getByRole('menu')).toHaveCount(0)

    const box = (await icon(page, 'Notes').boundingBox())!
    await page.mouse.click(box.x + 60, box.y + 40, { button: 'right' })
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem', { name: 'Open file location' })).toBeVisible()
    // At the right-click point (Radix opens a context menu 2 px right of the pointer), once its
    // opening animation has settled.
    await expect
      .poll(async () => {
        const opened = (await menu.boundingBox())!
        return [Math.round(opened.x), Math.round(opened.y)]
      })
      .toEqual([Math.round(box.x + 60) + 2, Math.round(box.y + 40)])
    await page.keyboard.press('Escape')
    expect(profile.readLog()).toContain(
      "shell-menu: no native menu (request-failed); showing Taskyard's menu"
    )
  })
})
