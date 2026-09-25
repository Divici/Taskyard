import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { WallpaperInfo } from '../src/shared/ipc'
import type { TaskyardApi } from '../src/preload/api'
import { createProfile, launchTaskyard } from './helpers/taskyard'

// Read only: the real wallpaper is served and painted; nothing changes the user's settings.

type BridgeWindow = { taskyard: TaskyardApi }

const displayIdOf = (page: Page): number =>
  Number(new URL(page.url()).searchParams.get('displayId'))

test("each desktop window paints its own display's wallpaper over taskyard://, under glass", async () => {
  const profile = createProfile()
  let app: ElectronApplication | undefined
  try {
    const taskyard = await launchTaskyard(profile)
    app = taskyard
    const displayCount = await app.evaluate(({ screen }) => screen.getAllDisplays().length)
    await expect.poll(() => taskyard.windows().length).toBe(displayCount)
    const pages = taskyard.windows()
    const cspErrors: string[] = []
    for (const page of pages) {
      page.on('console', (message) => {
        if (/Content Security Policy/i.test(message.text())) cspErrors.push(message.text())
      })
      await page.waitForURL(/[?&]displayId=\d+/)
    }

    for (const page of pages) {
      const displayId = displayIdOf(page)
      const info = (await page.evaluate(
        (id) => (globalThis as unknown as BridgeWindow).taskyard.wallpaper.get(id),
        displayId
      )) as WallpaperInfo | null
      expect(info?.displayId).toBe(displayId)
      const layer = page.getByTestId('wallpaper-layer')

      if (info!.url === null) {
        // A solid-colour desktop (or an unreadable wallpaper): colour only, with its hint.
        await expect(layer).toHaveAttribute('data-wallpaper-hint', /.+/)
        continue
      }
      expect(info!.url).toBe(`taskyard://wallpaper/${displayId}?v=${info!.version}`)

      // The layer swapped the decoded picture in (CSP allows taskyard: images).
      await expect(layer).toHaveAttribute('data-wallpaper-version', String(info!.version))
      const backgroundImage = await layer.evaluate((el) => getComputedStyle(el).backgroundImage)
      expect(backgroundImage).toBe(`url("${info!.url}")`)

      // The protocol serves real image bytes the renderer can decode.
      const size = await page.evaluate(async (url) => {
        const image = new Image()
        image.src = url
        await image.decode()
        return { width: image.naturalWidth, height: image.naturalHeight }
      }, info!.url)
      expect(size.width).toBeGreaterThan(0)
      expect(size.height).toBeGreaterThan(0)

      // An unknown display is a 404, never another file: the image does not load. (The CSP
      // allows taskyard: for images only; fetch() is refused, which is intended.)
      const unknownLoads = await page.evaluate(async () => {
        const image = new Image()
        image.src = 'taskyard://wallpaper/1234567?v=1'
        return image.decode().then(
          () => true,
          () => false
        )
      })
      expect(unknownLoads).toBe(false)
    }

    // Theme and glass: the root carries the resolved theme and the settings' glass values, and
    // the placeholder pane blurs the wallpaper behind it (unless transparency effects are off).
    const page = pages[0]
    const root = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      reduced: document.documentElement.hasAttribute('data-reduced-transparency'),
      blur: document.documentElement.style.getPropertyValue('--blur')
    }))
    expect(['dark', 'light']).toContain(root.theme)
    expect(root.blur).toBe('16px')
    const glass = await page
      .locator('.glass')
      .first()
      .evaluate((el) => getComputedStyle(el).backdropFilter)
    if (root.reduced) expect(glass).toBe('none')
    else expect(glass).toBe('blur(16px) saturate(1.2)')

    expect(cspErrors).toEqual([])
  } finally {
    await app?.close()
    profile.dispose()
  }
})
