import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TaskyardApi } from '../src/preload/api'
import { createProfile, launchTaskyard, type Profile } from './helpers/taskyard'
import { desktopWindowInfo, win32Probe } from './helpers/win32'

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

  test('opens one desktop window per display, each titled "Taskyard"', async () => {
    await expect(page).toHaveTitle('Taskyard')
    await expect(page.getByRole('heading', { level: 1, name: 'Taskyard' })).toBeVisible()

    const displayCount = await app.evaluate(({ screen }) => screen.getAllDisplays().length)
    await expect.poll(() => app.windows().length).toBe(displayCount)
    const titles = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.getTitle())
    )
    expect(titles).toEqual(Array.from({ length: displayCount }, () => 'Taskyard'))
  })

  test('covers each display, 1 px short of its bottom edge, with its displayId in the URL', async () => {
    const windows = await desktopWindowInfo(app)
    const displays = await app.evaluate(({ screen }) =>
      screen.getAllDisplays().map((display) => ({ id: display.id, bounds: display.bounds }))
    )

    expect(windows.map((window) => window.displayId).sort()).toEqual(
      displays.map((display) => display.id).sort()
    )
    for (const window of windows) {
      const display = displays.find((d) => d.id === window.displayId)!
      expect(window.bounds).toEqual({ ...display.bounds, height: display.bounds.height - 1 })
    }
  })

  test('shows every desktop window as a tool window seated above the shell desktop window', async () => {
    const probe = await win32Probe()
    const windows = await desktopWindowInfo(app)

    // Shown on ready-to-show (the first paint), then seated.
    await expect
      .poll(() => windows.every((w) => probe.isVisible(w.hwnd) && probe.isSeated(w.hwnd)), {
        timeout: 10_000
      })
      .toBe(true)
    for (const window of windows) {
      // WS_EX_TOOLWINDOW keeps it out of Alt-Tab and the taskbar; WS_EX_APPWINDOW would undo that.
      expect(probe.exStyle(window.hwnd) & probe.WS_EX_TOOLWINDOW).toBe(probe.WS_EX_TOOLWINDOW)
      expect(probe.exStyle(window.hwnd) & probe.WS_EX_APPWINDOW).toBe(0)
      expect(probe.isVisible(window.hwnd)).toBe(true)
      expect(probe.isIconic(window.hwnd)).toBe(false)
    }
  })

  test('has a real window rect that stops 1 px short of the bottom edge (no invisible frame)', async () => {
    const probe = await win32Probe()

    // The shell decides "full screen" from the HWND rect: with Electron's default thick frame it
    // is 8 px larger than the bounds on three sides and covers the whole monitor.
    for (const window of await desktopWindowInfo(app)) {
      expect(probe.windowRect(window.hwnd)).toEqual(window.screenBounds)
    }
  })

  test('paints its renderer onto the screen, not just the black window background', async () => {
    const probe = await win32Probe()
    const windows = await desktopWindowInfo(app)
    await expect
      .poll(() => windows.every((w) => probe.isVisible(w.hwnd) && probe.isSeated(w.hwnd)), {
        timeout: 10_000
      })
      .toBe(true)
    const spots = windows
      .map((window) => ({ window, point: probe.uncoveredPoint(window.hwnd) }))
      .filter((spot) => spot.point !== null)
    test.skip(spots.length === 0, 'other windows cover every Taskyard pixel on this desktop')

    // A window shown behind Chromium's back (raw ShowWindow) stays #000000, its backgroundColor.
    // The wallpaper layer may itself be black at any given spot (letterbox bars, a dark picture),
    // so the page paints a known colour there and the screen must show it.
    const [{ window, point }] = spots
    const target = app
      .windows()
      .find((p) => new URL(p.url()).searchParams.get('displayId') === String(window.displayId))!
    const scale = window.screenBounds.width / window.bounds.width
    await target.evaluate(
      ({ x, y }) => {
        const marker = document.createElement('div')
        marker.id = 'paint-probe'
        marker.style.cssText = `position:fixed;left:${x - 12}px;top:${y - 12}px;width:24px;height:24px;background:#ff00ff;z-index:2147483647`
        document.body.append(marker)
      },
      {
        x: (point!.x - window.screenBounds.x) / scale,
        y: (point!.y - window.screenBounds.y) / scale
      }
    )
    try {
      await expect.poll(() => probe.screenPixel(point!.x, point!.y)).toBe(0xff00ff)
    } finally {
      await target.evaluate(() => document.getElementById('paint-probe')?.remove())
    }
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

  test('boots in the locked order: stores, journal replay, windows, scan, watch', async () => {
    await expect.poll(() => profile.readLog()).toContain('boot: watch')
    const lines = profile.readLog().split(/\r?\n/)
    const at = (pattern: RegExp): number => {
      const index = lines.findIndex((line) => pattern.test(line))
      expect(index, `no log line matches ${pattern}`).toBeGreaterThanOrEqual(0)
      return index
    }

    // Each boot line is logged when its step ends; the window count from inside createWindows.
    const order = [
      at(/boot: loadStores \d+ ms/),
      at(/boot: replayJournal \d+ ms/),
      at(/desktop: \d+ display window\(s\)/),
      at(/boot: createWindows \d+ ms/),
      at(/boot: scan \d+ ms/),
      at(/boot: watch \d+ ms/)
    ]

    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(new Set(order).size).toBe(order.length)
  })

  test('logs the koffi user32 probe into the isolated profile', async () => {
    await expect.poll(() => profile.readLog()).toContain('koffi: user32 loaded (dev)')
    expect(profile.readLog()).not.toContain('koffi: user32 load failed')
  })
})
