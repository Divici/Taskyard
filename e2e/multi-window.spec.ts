import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { StoreSnapshot } from '../src/shared/ipc'
import type { TaskyardApi } from '../src/preload/api'
import { createProfile, launchTaskyard } from './helpers/taskyard'

type BridgeWindow = { taskyard: TaskyardApi }

interface ScreenDisplay {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
}

const displayIdOf = (page: Page): number =>
  Number(new URL(page.url()).searchParams.get('displayId'))

const loadLayout = (page: Page): Promise<StoreSnapshot<'layout'>> =>
  page.evaluate(() => (globalThis as unknown as BridgeWindow).taskyard.storage.load('layout'))

test('each desktop window gets its own display from main, and both register it in one layout', async () => {
  const profile = createProfile()
  let app: ElectronApplication | undefined
  try {
    const taskyard = await launchTaskyard(profile)
    app = taskyard
    const displays: ScreenDisplay[] = await app.evaluate(({ screen }) =>
      screen.getAllDisplays().map(({ id, bounds, scaleFactor }) => ({ id, bounds, scaleFactor }))
    )
    await expect.poll(() => taskyard.windows().length).toBe(displays.length)
    const pages = taskyard.windows()
    // A window's URL is only final once its navigation to index.html?displayId= has committed.
    for (const page of pages) await page.waitForURL(/[?&]displayId=\d+/)

    // Each window asked main (display:get, through the sender guard) for the display in its URL
    // and got that display's own id, bounds and scale factor.
    expect(pages.map(displayIdOf).sort()).toEqual(displays.map((d) => d.id).sort())
    for (const page of pages) {
      const display = displays.find((d) => d.id === displayIdOf(page))!
      const { x, y, width, height } = display.bounds
      const main = page.getByRole('main')
      await expect(main).toHaveAttribute('data-display-id', String(display.id))
      await expect(main).toHaveAttribute('data-display-bounds', `${x},${y},${width},${height}`)
      await expect(main).toHaveAttribute('data-scale-factor', String(display.scaleFactor))
      await expect(main).toHaveAttribute('data-peeking', 'false')
    }

    // Both windows hydrated and registered their display at the same moment, on a fresh profile:
    // their saves raced on revision 1. The layout still ends with exactly one entry per display.
    await expect
      .poll(async () => (await loadLayout(pages[0])).data.displays.length)
      .toBe(displays.length)
    const settled = await loadLayout(pages[0])
    // One accepted save per window (revision 1 is the loaded file), then quiet: no window saves
    // again in reaction to the other's save (no echo ping-pong).
    expect(settled.revision).toBe(1 + displays.length)
    await pages[0].waitForTimeout(1_500)
    expect((await loadLayout(pages[0])).revision).toBe(settled.revision)
    for (const page of pages) expect(await loadLayout(page)).toEqual(settled)

    await app.close()

    const onDisk = JSON.parse(readFileSync(join(profile.userData, 'layout.json'), 'utf8')) as {
      displays: { displayId: number; bounds: ScreenDisplay['bounds'] }[]
    }
    const byId = (a: { id: number }, b: { id: number }): number => a.id - b.id
    expect(onDisk.displays.map((d) => ({ id: d.displayId, bounds: d.bounds })).sort(byId)).toEqual(
      displays.map((d) => ({ id: d.id, bounds: d.bounds })).sort(byId)
    )
    expect(profile.readLog()).not.toContain('ipc: rejected')
  } finally {
    // Closed even when an assertion failed, so the profile can be removed.
    await app?.close().catch(() => {})
    profile.dispose()
  }
})

test('F12 toggles detached DevTools on a desktop window in an unpackaged build', async () => {
  const profile = createProfile()
  let app: ElectronApplication | undefined
  try {
    const taskyard = await launchTaskyard(profile)
    app = taskyard
    await app.firstWindow()
    await expect.poll(() => profile.readLog()).toMatch(/desktop: \d+ display window\(s\)/)
    const pressF12 = (): Promise<void> =>
      taskyard.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows()
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F12' })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F12' })
      })
    const devToolsOpen = (): Promise<boolean> =>
      taskyard.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened()
      )

    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(false)
    await pressF12()
    await expect.poll(devToolsOpen).toBe(true)
    await pressF12()
    await expect.poll(devToolsOpen).toBe(false)

    await app.close()
  } finally {
    // Closed even when an assertion failed, so the profile can be removed.
    await app?.close().catch(() => {})
    profile.dispose()
  }
})

test('a page that vetoes its unload (beforeunload) cannot block the quit', async () => {
  const profile = createProfile()
  const taskyard = await launchTaskyard(profile)
  const child = taskyard.process()
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  try {
    const page = await taskyard.firstWindow()
    await page.waitForURL(/[?&]displayId=\d+/)
    await expect(page.getByRole('main')).toHaveAttribute('data-display-id', /^\d+$/)
    await page.evaluate(() => {
      addEventListener('beforeunload', (event) => {
        event.preventDefault()
        event.returnValue = ''
      })
    })
    // Chromium honours beforeunload only after a user gesture in the page (CDP input: no OS focus).
    await page.mouse.click(4, 4)
    // Playwright would otherwise answer the beforeunload "dialog" itself over CDP; Electron's
    // will-prevent-unload (the path under test) is the browser-side handler that decides.
    page.on('dialog', () => {})

    // Quit from main, as the tray or an installer's WM_CLOSE would.
    void taskyard.evaluate(({ app }) => app.quit()).catch(() => {})
    const outcome = await Promise.race([
      exited,
      new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), 15_000))
    ])

    expect(outcome).toBe(0)
    expect(profile.readLog()).toContain("desktop: ignored the page's beforeunload on display")
  } finally {
    if (child.exitCode === null && child.pid !== undefined) {
      // A blocked quit never exits on its own: end the whole process tree so nothing lingers.
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)])
      await exited
      // Its child processes release the profile's files a moment later.
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    } else {
      await taskyard.close().catch(() => {})
    }
    profile.dispose()
  }
})
