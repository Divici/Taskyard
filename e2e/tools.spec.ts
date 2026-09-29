import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { LayoutFile, TasksFile } from '../src/shared/schema'
import { createProfile, launchTaskyard, primaryWindow, type Profile } from './helpers/taskyard'

// Everything runs against a temp profile (TASKYARD_USER_DATA) and a temp desktop folder.

function saved<T>(profile: Profile, file: string): T | null {
  try {
    return JSON.parse(readFileSync(join(profile.userData, file), 'utf8')) as T
  } catch {
    return null // not written yet (or mid-write)
  }
}

const savedTasks = (profile: Profile): TasksFile | null => saved<TasksFile>(profile, 'tasks.json')

/** "mm:ss" or "h:mm:ss" → seconds. */
function seconds(clock: string): number {
  return clock
    .trim()
    .split(':')
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0)
}

async function activeTexts(widget: Locator): Promise<string[]> {
  return widget
    .getByRole('list', { name: 'Tasks' })
    .getByRole('listitem')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label') ?? ''))
}

async function addTask(widget: Locator, text: string): Promise<void> {
  const input = widget.getByRole('textbox', { name: 'Add a task' })
  await input.fill(text)
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
}

/** Round 2: adds a task the mouse way — type, then click the round + ("Add task") button. */
async function addTaskWithButton(page: Page, widget: Locator, text: string): Promise<void> {
  const input = widget.getByRole('textbox', { name: 'Add a task' })
  const add = widget.getByRole('button', { name: 'Add task' })
  await input.click()
  await page.keyboard.type(text)
  await expect(add).toBeEnabled()
  await add.click()
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
  await expect(add).toBeDisabled()
}

/** "h:mm:ss.t" → milliseconds. */
function stopwatchMs(clock: string): number {
  const [h, m, s] = clock.trim().split(':')
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000
}

test('tools: 3 tasks, one completed, reordered, a linked 2-minute timer → restart → all still there, timer still running', async () => {
  const profile = createProfile()
  let app: ElectronApplication | undefined
  try {
    app = await launchTaskyard(profile)
    let page = await primaryWindow(app)

    // The widget shows on the primary display only (its default), on the Tasks tool.
    let widget = page.getByRole('region', { name: 'Tools' })
    await expect(widget).toBeVisible()
    await expect(widget.getByRole('heading', { name: 'Tasks' })).toBeVisible()
    await expect(widget.getByText('Nothing to do.')).toBeVisible()
    const displayCount = await app.evaluate(({ screen }) => screen.getAllDisplays().length)
    await expect
      .poll(() => saved<LayoutFile>(profile, 'layout.json')?.displays.length ?? 0)
      .toBe(displayCount)
    const layout = saved<LayoutFile>(profile, 'layout.json')!
    expect(layout.displays.filter((display) => display.tools.visible)).toHaveLength(1)

    // Round 2: the tabs sit on top — Tasks · Timer · Stopwatch.
    await expect(widget.getByRole('tab')).toHaveText(['Tasks', 'Timer', 'Stopwatch'])

    // Add 3 tasks: with the real mouse on the + button, and with Enter.
    const input = widget.getByRole('textbox', { name: 'Add a task' })
    const addButton = widget.getByRole('button', { name: 'Add task' })
    await expect(input).toHaveAttribute('placeholder', 'Add a task…')
    await expect(addButton).toBeDisabled()
    // A press on the (disabled) + or anywhere on the row puts the caret in the field.
    await addButton.click({ force: true })
    await expect(input).toBeFocused()
    await input.blur()
    await expect(input).not.toBeFocused()
    const row = await widget.locator('[data-add-row]').boundingBox()
    await page.mouse.click(row!.x + 5, row!.y + row!.height / 2)
    await expect(input).toBeFocused()
    await addTaskWithButton(page, widget, 'Write report')
    for (const text of ['Water plants', 'Call the bank']) {
      await addTask(widget, text)
    }
    expect(await activeTexts(widget)).toEqual(['Write report', 'Water plants', 'Call the bank'])

    // Complete one: it leaves the active list for the collapsed Completed section.
    await widget.getByRole('checkbox', { name: 'Water plants' }).click()
    expect(await activeTexts(widget)).toEqual(['Write report', 'Call the bank'])
    await expect(widget.getByRole('button', { name: 'Completed (1)' })).toBeVisible()

    // Reorder: Alt+↑ on the focused row.
    await widget.getByRole('listitem', { name: 'Call the bank' }).focus()
    await page.keyboard.press('Alt+ArrowUp')
    expect(await activeTexts(widget)).toEqual(['Call the bank', 'Write report'])
    await expect(widget.getByRole('listitem', { name: 'Call the bank' })).toBeFocused()

    // A 2-minute timer, focused on a task, started.
    await widget.getByRole('tab', { name: 'Timer' }).click()
    await expect(widget.getByRole('heading', { name: 'Timer' })).toBeVisible()
    const custom = widget.getByRole('spinbutton', { name: 'Custom minutes' })
    await custom.fill('2')
    await custom.press('Enter')
    await expect(widget.getByRole('timer', { name: 'Time left' })).toHaveText('02:00')
    await widget
      .getByRole('combobox', { name: 'Focus on…' })
      .selectOption({ label: 'Write report' })
    await widget.getByRole('button', { name: 'Start' }).click()
    await expect(widget.getByRole('button', { name: 'Pause' })).toBeVisible()
    await expect(widget.getByRole('tab', { name: 'Timer' })).toHaveAccessibleDescription('Running')

    // Round 2: tidy layout — at the default 320 × 400 the whole Timer fits (no scrolling), the
    // task sits on its own line under the ring, and everything shares one centre line.
    await expect(widget.getByText('Focus: Write report')).toBeVisible()
    const view = widget.getByRole('group', { name: 'Timer' })
    const fit = await view.evaluate((node) => ({
      scroll: node.scrollHeight,
      client: node.clientHeight
    }))
    expect(fit.scroll).toBeLessThanOrEqual(fit.client)
    const centres = await Promise.all(
      [
        widget.getByTestId('timer-ring'),
        widget.getByText('Focus: Write report'),
        widget.getByRole('button', { name: 'Pause' }).locator('..'),
        widget.getByRole('group', { name: 'Presets' })
      ].map(async (part) => {
        const box = (await part.boundingBox())!
        return Math.round(box.x + box.width / 2)
      })
    )
    for (const centre of centres) expect(Math.abs(centre - centres[0])).toBeLessThanOrEqual(1)

    // Saved (debounced atomic write in main).
    await expect.poll(() => savedTasks(profile)?.timer.status).toBe('running')
    await expect
      .poll(() =>
        savedTasks(profile)
          ?.tasks.filter((task) => !task.done)
          .map((task) => task.text)
      )
      .toEqual(['Call the bank', 'Write report'])
    const before = savedTasks(profile)!
    const linked = before.tasks.find((task) => task.text === 'Write report')!
    expect(before.timer).toMatchObject({ durationMs: 120_000, linkedTaskId: linked.id })
    const leftBefore = seconds(await widget.getByRole('timer').innerText())
    expect(leftBefore).toBeLessThanOrEqual(120)

    // Restart.
    await page.waitForTimeout(1_500)
    await app.close()
    app = await launchTaskyard(profile)
    page = await primaryWindow(app)
    widget = page.getByRole('region', { name: 'Tools' })

    // The timer is still running, from the same absolute endsAt, with less time left.
    await expect(widget.getByRole('heading', { name: 'Timer' })).toBeVisible()
    await expect(widget.getByRole('button', { name: 'Pause' })).toBeVisible()
    const timerText = widget.getByRole('timer', { name: 'Time left' })
    await expect.poll(async () => seconds(await timerText.innerText())).toBeLessThan(leftBefore)
    expect(seconds(await timerText.innerText())).toBeGreaterThan(0)
    await expect(widget.getByRole('combobox', { name: 'Focus on…' })).toHaveValue(linked.id)
    const after = savedTasks(profile)!
    expect(after.timer).toEqual(before.timer)

    // The tasks are identical.
    expect(after.tasks).toEqual(before.tasks)
    await widget.getByRole('tab', { name: 'Tasks' }).click()
    expect(await activeTexts(widget)).toEqual(['Call the bank', 'Write report'])
    await widget.getByRole('button', { name: 'Completed (1)' }).click()
    await expect(
      widget.getByRole('list', { name: 'Completed tasks' }).getByRole('checkbox', {
        name: 'Water plants'
      })
    ).toHaveAttribute('aria-checked', 'true')
  } finally {
    await app?.close()
    profile.dispose()
  }
})

test('stopwatch: start, laps, linked task → restart → still counting from the same start, laps kept', async () => {
  const profile = createProfile()
  let app: ElectronApplication | undefined
  try {
    app = await launchTaskyard(profile)
    let page = await primaryWindow(app)
    let widget = page.getByRole('region', { name: 'Tools' })
    await expect(widget).toBeVisible()
    await addTask(widget, 'Deep work')

    // The Stopwatch tab, with the mouse.
    await widget.getByRole('tab', { name: 'Stopwatch' }).click()
    await expect(widget.getByRole('heading', { name: 'Stopwatch' })).toBeVisible()
    const clock = widget.getByRole('timer', { name: 'Elapsed time' })
    await expect(clock).toHaveText('0:00:00.0')
    await widget.getByRole('combobox', { name: 'Focus on…' }).selectOption({ label: 'Deep work' })
    await expect(widget.getByText('Focus: Deep work')).toBeVisible()

    // Start; it counts up; the tab wears the running dot.
    await widget.getByRole('button', { name: 'Start' }).click()
    await expect(widget.getByRole('button', { name: 'Pause' })).toBeVisible()
    await expect.poll(async () => stopwatchMs(await clock.innerText())).toBeGreaterThanOrEqual(500)
    await expect(widget.getByRole('tab', { name: 'Stopwatch' })).toHaveAccessibleDescription(
      'Running'
    )

    // At the widget's 280 px minimum (real resize from its right edge), with the Stopwatch tab
    // selected and running (its dot showing), every tab name is whole (not clipped) and centred.
    const edge = (await widget.locator('[data-resize-edge="e"]').boundingBox())!
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
    await page.mouse.down()
    await page.mouse.move(edge.x - 150, edge.y + edge.height / 2, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => (await widget.boundingBox())!.width).toBe(280)
    const labels = await widget.getByRole('tab').evaluateAll((tabs) =>
      tabs.map((tab) => {
        const label = tab.querySelector('[data-tab-label]') as HTMLElement
        const t = tab.getBoundingClientRect()
        const l = label.getBoundingClientRect()
        return {
          text: label.textContent,
          clipped: label.scrollWidth > label.clientWidth,
          offCentre: Math.abs(l.left + l.width / 2 - (t.left + t.width / 2))
        }
      })
    )
    for (const label of labels) {
      expect(label, label.text ?? '').toMatchObject({ clipped: false })
      expect(label.offCentre, label.text ?? '').toBeLessThanOrEqual(1)
    }

    // Two laps, newest first.
    await widget.getByRole('button', { name: 'Lap' }).click()
    await page.waitForTimeout(300)
    await widget.getByRole('button', { name: 'Lap' }).click()
    const laps = widget.getByRole('list', { name: 'Laps' }).getByRole('listitem')
    await expect(laps).toHaveCount(2)
    await expect(laps.first()).toHaveAccessibleName(/^Lap 2: split /)

    // Space on the view pauses and resumes it.
    await widget.getByRole('group', { name: 'Stopwatch' }).focus()
    await page.keyboard.press('Space')
    await expect(widget.getByRole('button', { name: 'Resume' })).toBeVisible()
    await page.keyboard.press('Space')
    await expect(widget.getByRole('button', { name: 'Pause' })).toBeVisible()

    // Saved in tasks.json as `stopwatch`: running from an absolute startedAt.
    await expect.poll(() => savedTasks(profile)?.stopwatch.laps.length).toBe(2)
    await expect.poll(() => savedTasks(profile)?.stopwatch.status).toBe('running')
    const before = savedTasks(profile)!
    const task = before.tasks.find((entry) => entry.text === 'Deep work')!
    expect(before.stopwatch).toMatchObject({ linkedTaskId: task.id })
    expect(before.stopwatch.startedAt).toBeGreaterThan(0)
    const elapsedBefore = stopwatchMs(await clock.innerText())

    // Restart.
    await page.waitForTimeout(1_500)
    await app.close()
    app = await launchTaskyard(profile)
    page = await primaryWindow(app)
    widget = page.getByRole('region', { name: 'Tools' })

    // Still on the Stopwatch tab, still running, further along; laps and link kept.
    await expect(widget.getByRole('heading', { name: 'Stopwatch' })).toBeVisible()
    await expect(widget.getByRole('button', { name: 'Pause' })).toBeVisible()
    const after = widget.getByRole('timer', { name: 'Elapsed time' })
    await expect
      .poll(async () => stopwatchMs(await after.innerText()))
      .toBeGreaterThan(elapsedBefore + 1_000)
    await expect(widget.getByRole('list', { name: 'Laps' }).getByRole('listitem')).toHaveCount(2)
    await expect(widget.getByText('Focus: Deep work')).toBeVisible()
    expect(savedTasks(profile)!.stopwatch).toEqual(before.stopwatch)

    // Rolled up on the Stopwatch tab, the header keeps counting.
    await widget.getByRole('button', { name: 'Tools options' }).click()
    await page.getByRole('menuitem', { name: 'Roll up' }).click()
    const header = widget.getByRole('timer', { name: 'Elapsed time' })
    await expect(header).toBeVisible()
    const first = stopwatchMs(await header.innerText())
    await expect.poll(async () => stopwatchMs(await header.innerText())).toBeGreaterThan(first)

    // Reset clears it (after rolling back down).
    await widget.getByRole('button', { name: 'Tools options' }).click()
    await page.getByRole('menuitem', { name: 'Roll down' }).click()
    await widget.getByRole('button', { name: 'Reset' }).click()
    await expect(widget.getByRole('timer', { name: 'Elapsed time' })).toHaveText('0:00:00.0')
    await expect.poll(() => savedTasks(profile)?.stopwatch.status).toBe('idle')
    expect(savedTasks(profile)!.stopwatch.laps).toEqual([])
  } finally {
    await app?.close()
    profile.dispose()
  }
})

interface Centring {
  /** The content's centre minus its scroll body's centre (px). */
  dx: number
  dy: number
  /** The content's top minus the body's top (px). */
  top: number
  overflow: boolean
  scrollTop: number
}

/**
 * Where a tool's content sits in the scroll body around `part` (the nearest ancestor that
 * scrolls vertically): the content is the union of the body's in-flow children.
 */
function centring(part: Locator): Promise<Centring> {
  return part.evaluate((node) => {
    let body: HTMLElement | null = node as HTMLElement
    while (body && !['auto', 'scroll'].includes(getComputedStyle(body).overflowY)) {
      body = body.parentElement
    }
    if (!body) throw new Error('no scroll body')
    const rects = Array.from(body.children)
      .filter((child) => getComputedStyle(child).position !== 'absolute')
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.height > 0)
    const top = Math.min(...rects.map((rect) => rect.top))
    const bottom = Math.max(...rects.map((rect) => rect.bottom))
    const left = Math.min(...rects.map((rect) => rect.left))
    const right = Math.max(...rects.map((rect) => rect.right))
    const box = body.getBoundingClientRect()
    const bodyTop = box.top + body.clientTop
    const bodyLeft = box.left + body.clientLeft
    return {
      dx: (left + right) / 2 - (bodyLeft + body.clientWidth / 2),
      dy: (top + bottom) / 2 - (bodyTop + body.clientHeight / 2),
      top: top - bodyTop,
      overflow: body.scrollHeight > body.clientHeight,
      scrollTop: body.scrollTop
    }
  })
}

/** Each tool's content is centred in its body (Tasks: the list area under the add row). */
async function expectCentred(widget: Locator): Promise<void> {
  const parts: Array<[string, Locator]> = [
    ['Tasks', widget.getByRole('list', { name: 'Tasks' })],
    ['Timer', widget.getByTestId('timer-ring')],
    ['Stopwatch', widget.getByTestId('stopwatch-ring')]
  ]
  for (const [tool, part] of parts) {
    await widget.getByRole('tab', { name: tool }).click()
    await expect(widget.getByRole('heading', { name: tool })).toBeVisible()
    const at = await centring(part)
    expect(at.overflow, tool).toBe(false)
    expect(Math.abs(at.dy), `${tool} dy`).toBeLessThanOrEqual(2)
    expect(Math.abs(at.dx), `${tool} dx`).toBeLessThanOrEqual(2)
  }
}

/** Drags one of the widget's resize edges with the real mouse. */
async function dragEdge(
  page: Page,
  widget: Locator,
  edge: string,
  dx: number,
  dy: number
): Promise<void> {
  const box = (await widget.locator(`[data-resize-edge="${edge}"]`).boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 8 })
  await page.mouse.up()
}

test('centred content: resized taller with the mouse, each tool centres; 50 laps start at the top and scroll', async () => {
  const profile = createProfile()
  let app: ElectronApplication | undefined
  try {
    app = await launchTaskyard(profile)
    const page = await primaryWindow(app)
    const widget = page.getByRole('region', { name: 'Tools' })
    await expect(widget).toBeVisible()

    // At the default size, and at the 280 px minimum width made much taller (real mouse).
    await expectCentred(widget)
    const start = (await widget.boundingBox())!
    await dragEdge(page, widget, 'e', -150, 0)
    await expect.poll(async () => (await widget.boundingBox())!.width).toBe(280)
    await dragEdge(page, widget, 's', 0, 320)
    await expect
      .poll(async () => (await widget.boundingBox())!.height)
      .toBeGreaterThanOrEqual(start.height + 300)
    await expectCentred(widget)

    // With tasks (active and completed) the list area still centres; the add row stays on top.
    await widget.getByRole('tab', { name: 'Tasks' }).click()
    for (const text of ['Write report', 'Water plants', 'Call the bank'])
      await addTask(widget, text)
    await widget.getByRole('checkbox', { name: 'Water plants' }).click()
    await expectCentred(widget)
    await widget.getByRole('tab', { name: 'Tasks' }).click()
    const row = (await widget.locator('[data-add-row]').boundingBox())!
    const tabs = (await widget.getByRole('tablist').boundingBox())!
    expect(row.y - (tabs.y + tabs.height)).toBeLessThanOrEqual(12)

    // After a roll-up and back, still centred.
    await widget.getByRole('button', { name: 'Tools options' }).click()
    await page.getByRole('menuitem', { name: 'Roll up' }).click()
    await expect(widget.getByRole('tabpanel')).toHaveCount(0)
    await widget.getByRole('button', { name: 'Tools options' }).click()
    await page.getByRole('menuitem', { name: 'Roll down' }).click()
    await expect(widget.getByRole('tabpanel')).toBeVisible()
    await expect
      .poll(async () => (await widget.boundingBox())!.height)
      .toBeGreaterThanOrEqual(start.height + 300)
    await expectCentred(widget)

    // 50 laps: taller than the body, so the content starts at the top (nothing clipped) and the
    // body scrolls, from the top, with the mouse wheel.
    await widget.getByRole('tab', { name: 'Stopwatch' }).click()
    await widget.getByRole('button', { name: 'Start' }).click()
    const lap = widget.getByRole('button', { name: 'Lap' })
    const laps = widget.getByRole('list', { name: 'Laps' }).getByRole('listitem')
    for (let n = 1; n <= 50; n++) await lap.click()
    await expect(laps).toHaveCount(50)
    const ring = widget.getByTestId('stopwatch-ring')
    const tall = await centring(ring)
    expect(tall).toMatchObject({ overflow: true, scrollTop: 0 })
    expect(Math.abs(tall.top)).toBeLessThanOrEqual(1)
    await expect(ring).toBeInViewport({ ratio: 1 })
    await expect(widget.getByRole('button', { name: 'Pause' })).toBeInViewport({ ratio: 1 })
    await expect(laps.last()).not.toBeInViewport()
    const body = (await widget.getByRole('group', { name: 'Stopwatch' }).boundingBox())!
    await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2)
    await page.mouse.wheel(0, 5_000)
    await expect.poll(async () => (await centring(ring)).scrollTop).toBeGreaterThan(0)
    await expect(laps.last()).toBeInViewport()
    await expect(laps.last()).toHaveAccessibleName(/^Lap 1: split /)
  } finally {
    await app?.close()
    profile.dispose()
  }
})
