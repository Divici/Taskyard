import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator } from '@playwright/test'
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

    // Add 3 tasks.
    for (const text of ['Write report', 'Water plants', 'Call the bank']) {
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
