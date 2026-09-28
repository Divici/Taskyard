import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { localWorkArea } from '../src/shared/geometry'
import { defaultSettings } from '../src/shared/defaults'
import type { DisplayInfo } from '../src/shared/ipc'
import type { TaskyardApi } from '../src/preload/api'
import { PERF_COUNTS, perfLayout, writePerfDesktop } from '../scripts/perf-fixture'
import { summarizeFrames } from '../scripts/lib/perf-stats'
import { createProfile, launchTaskyard, primaryWindow, type Profile } from './helpers/taskyard'

// Phase 12 performance budget, on the fixture (12 groups / 200 items, 150 .lnk to real System32
// programs) in temp folders — never the real desktop:
//   - scan ≤ 300 ms (main's own "scan: N items in X ms" log line);
//   - warm startup-to-icons ≤ 1.5 s (icon cache on disk); cold (empty cache) reported only;
//   - p95 frame time ≤ 18 ms over a scripted 3 s group drag, measured during Peek, so the
//     window is on top and unoccluded (Chromium throttles frames of covered windows).
// "Startup-to-icons" runs from the main process's start (process.uptime, not Playwright's launch
// overhead) until all 200 tiles are drawn with an icon (no skeleton tile left).

const SCAN_BUDGET_MS = 300
const WARM_BUDGET_MS = 1_500
const P95_BUDGET_MS = 18
const DRAG_MS = 3_000

type Api = { taskyard: TaskyardApi }
/** The in-page frame recorder: rAF timestamps and the dragged group's left edge per frame. */
type Recorder = { __frames: number[]; __lefts: number[]; __recording: boolean }

const settings = JSON.stringify({ ...defaultSettings(), firstRunDone: true, autostart: false })

/** Epoch ms when this app's main process started. */
async function mainStartedAt(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => Date.now() - process.uptime() * 1000)
}

/** Epoch ms when all `count` tiles first showed an icon (polled every 10 ms in the page). */
async function iconsShownAt(page: Page, count: number): Promise<number> {
  await page.waitForFunction(
    (n) =>
      document.querySelectorAll('[data-icon]').length === n &&
      document.querySelector('[data-icon="skeleton"]') === null,
    count,
    { polling: 10, timeout: 30_000 }
  )
  return Date.now()
}

async function startupToIcons(profile: Profile): Promise<{ app: ElectronApplication; ms: number }> {
  const app = await launchTaskyard(profile)
  const started = await mainStartedAt(app)
  const page = await primaryWindow(app)
  const shown = await iconsShownAt(page, PERF_COUNTS.total)
  return { app, ms: Math.round(shown - started) }
}

function scanMs(log: string): number {
  const matches = [...log.matchAll(/scan: (\d+) items in (\d+) ms/g)]
  const last = matches.at(-1)
  expect(last, 'a scan log line').toBeDefined()
  expect(Number(last![1])).toBe(PERF_COUNTS.total)
  return Number(last![2])
}

test('performance budget on the 200-item fixture: scan, startup-to-icons, drag frame time', async () => {
  test.setTimeout(180_000)
  const profile = createProfile()
  let app: ElectronApplication | undefined
  try {
    // 1. Which display is primary (a launch on an empty desktop), for the fixture's layout.
    app = await launchTaskyard(profile)
    await primaryWindow(app)
    const primary: DisplayInfo = await app.evaluate(({ screen }) => {
      const d = screen.getPrimaryDisplay()
      return { id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor }
    })
    await app.close()
    app = undefined

    // 2. The fixture: 200 items on the temp desktop, 12 groups, a fresh icon cache.
    const paths = writePerfDesktop(profile.desktop)
    const ids = paths.map((path) => {
      const stats = statSync(path, { bigint: true })
      return `${stats.dev}:${stats.ino}`
    })
    const byId = Object.fromEntries(ids.map((id, i) => [id, paths[i]]))
    const layout = perfLayout(ids, byId, {
      id: primary.id,
      bounds: primary.bounds,
      workArea: localWorkArea(primary)
    })
    writeFileSync(join(profile.userData, 'layout.json'), JSON.stringify(layout))
    writeFileSync(join(profile.userData, 'settings.json'), settings)
    mkdirSync(join(profile.userData, 'logs'), { recursive: true })

    // 3. Cold: nothing cached — every icon is fetched and extracted for the first time.
    const probeLog = profile.readLog().length
    const cold = await startupToIcons(profile)
    app = cold.app
    const coldLog = (): string => profile.readLog().slice(probeLog)
    const coldScan = scanMs(coldLog())
    await expect.poll(coldLog).toMatch(/icons: boot pass \d+ ms/)
    const coldPass = /icons: boot pass (\d+) ms/.exec(coldLog())![1]
    await app.close()
    app = undefined

    // 4. Warm: the icon cache is on disk.
    const logBefore = profile.readLog().length
    const warm = await startupToIcons(profile)
    app = warm.app
    const warmLog = profile.readLog().slice(logBefore)
    const warmScan = scanMs(warmLog)
    const page = await primaryWindow(app)
    await expect(page.locator('[data-group-id]')).toHaveCount(12)

    // 5. Peek (held, as the settings inspector does): the window is on top, frames unthrottled.
    await page.evaluate(() => (globalThis as unknown as Api).taskyard.peek.hold(true))
    await expect(page.getByRole('main')).toHaveAttribute('data-peeking', 'true')
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible')

    // 6. A scripted 3 s drag of the first group by its title bar, while rAF timestamps record.
    const header = page.locator('[data-group-id="perf-0"] header')
    const box = (await header.boundingBox())!
    const from = { x: box.x + 60, y: box.y + box.height / 2 }
    await page.evaluate(() => {
      const w = globalThis as unknown as Recorder
      const group = document.querySelector<HTMLElement>('[data-group-id="perf-0"]')!
      w.__frames = []
      w.__recording = true
      w.__lefts = []
      const loop = (t: number): void => {
        w.__frames.push(t)
        w.__lefts.push(group.offsetLeft)
        if (w.__recording) requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    })
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    const t0 = Date.now()
    for (let elapsed = 0; elapsed < DRAG_MS; elapsed = Date.now() - t0) {
      // A wide loop over the other groups (and back), so blur and hit-testing are exercised.
      const phase = (elapsed / DRAG_MS) * 2 * Math.PI
      await page.mouse.move(from.x + 700 * Math.sin(phase), from.y + 300 * (1 - Math.cos(phase)))
    }
    await page.mouse.up()
    const { stamps, lefts } = await page.evaluate(() => {
      const w = globalThis as unknown as Recorder
      w.__recording = false
      return { stamps: w.__frames, lefts: w.__lefts }
    })
    const frames = summarizeFrames(stamps)
    // The group really followed the pointer (a drag, not just pointer moves).
    const travel = Math.max(...lefts) - Math.min(...lefts)
    await page.evaluate(() => (globalThis as unknown as Api).taskyard.peek.hold(false))

    const results = {
      scanColdMs: coldScan,
      scanWarmMs: warmScan,
      startupToIconsColdMs: cold.ms,
      iconBootPassColdMs: Number(coldPass),
      startupToIconsWarmMs: warm.ms,
      dragFrames: frames.frames,
      frameMedianMs: Number(frames.medianMs.toFixed(2)),
      frameP95Ms: Number(frames.p95Ms.toFixed(2)),
      frameWorstMs: Number(frames.worstMs.toFixed(2)),
      refreshHz: frames.refreshHz,
      groupTravelPx: travel
    }
    console.log(`perf: ${JSON.stringify(results)}`)
    for (const [type, value] of Object.entries(results)) {
      test.info().annotations.push({ type, description: String(value) })
    }

    expect(warmScan).toBeLessThanOrEqual(SCAN_BUDGET_MS)
    expect(warm.ms).toBeLessThanOrEqual(WARM_BUDGET_MS)
    expect(travel).toBeGreaterThan(500)
    expect(frames.frames).toBeGreaterThan((DRAG_MS / 1000) * 30)
    expect(frames.p95Ms).toBeLessThanOrEqual(P95_BUDGET_MS)
  } finally {
    await app?.close()
    profile.dispose()
  }
})
