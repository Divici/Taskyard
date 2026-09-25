import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { TaskyardApi } from '../src/preload/api'
import { createProfile, launchTaskyard } from './helpers/taskyard'

type BridgeWindow = { taskyard: TaskyardApi }

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('a setting saved 100 ms before quit is on disk after the app exits', async () => {
  const profile = createProfile()
  try {
    const app = await launchTaskyard(profile)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const result = await page.evaluate(async () => {
      const { taskyard } = globalThis as unknown as BridgeWindow
      const { revision, data } = await taskyard.storage.load('settings')
      return taskyard.storage.save('settings', {
        baseRevision: revision,
        data: { ...data, theme: 'dark', glassBlur: 22 }
      })
    })
    expect(result).toEqual({ ok: true, revision: 2 })

    await page.waitForTimeout(100)
    await app.close()

    const saved = readJson(join(profile.userData, 'settings.json'))
    expect(saved).toMatchObject({ version: 1, theme: 'dark', glassBlur: 22 })
  } finally {
    profile.dispose()
  }
})

test('a corrupt layout.json is quarantined, restored from .bak and announced with a toast', async () => {
  const profile = createProfile()
  const layoutFile = join(profile.userData, 'layout.json')
  const backup = {
    version: 1,
    displays: [
      {
        displayId: 1,
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        groups: [],
        loose: { '1:2': { x: 8, y: 8 } },
        tools: { x: 32, y: 32, w: 320, h: 400, rolledUp: false, visible: true, activeTool: 'tasks' }
      }
    ],
    paths: { '1:2': 'C:\\Users\\me\\Desktop\\a.txt' },
    lastSeen: {}
  }
  writeFileSync(layoutFile, '{"version":1,"displays":[{')
  writeFileSync(`${layoutFile}.bak`, JSON.stringify(backup))
  try {
    const app = await launchTaskyard(profile)
    const page = await app.firstWindow()

    // dnd-kit's drag announcements are a status region too (Phase 8): the toasts' one is meant.
    await expect(
      page.getByRole('region', { name: 'Notifications' }).getByRole('status')
    ).toContainText('Taskyard couldn’t read your desktop layout, so it restored the last backup.')
    // The restored backup is what the windows start from. Its display id (1) is not a real one,
    // so main re-matches that entry to a connected display (Phase 11: same bounds, else same
    // size, else the primary) before the windows register theirs: one entry per display.
    const displayCount = await app.evaluate(({ screen }) => screen.getAllDisplays().length)
    const displayIds = await app.evaluate(({ screen }) => screen.getAllDisplays().map((d) => d.id))
    const loadLayout = (): Promise<{ revision: number; data: typeof backup }> =>
      page.evaluate(() =>
        (globalThis as unknown as BridgeWindow).taskyard.storage.load('layout')
      ) as Promise<{ revision: number; data: typeof backup }>
    await expect.poll(async () => (await loadLayout()).data.displays.length).toBe(displayCount)
    const loaded = await loadLayout()
    expect(loaded.data.displays.map((d) => d.displayId).sort()).toEqual([...displayIds].sort())
    // The backup's loose icon survived the re-match (on whichever display took the entry).
    expect(loaded.data.displays.some((d) => d.loose['1:2'] !== undefined)).toBe(true)
    expect(loaded.data.paths).toEqual(backup.paths)
    await app.close()

    const quarantined = readdirSync(profile.userData).filter((name) =>
      /^layout\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/.test(name)
    )
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(profile.userData, quarantined[0]), 'utf8')).toBe(
      '{"version":1,"displays":[{'
    )
    expect(readJson(layoutFile)).toEqual(loaded.data)
  } finally {
    profile.dispose()
  }
})

test('a tasks.json from a newer version shows the read-only banner and is never overwritten', async () => {
  const profile = createProfile()
  const tasksFile = join(profile.userData, 'tasks.json')
  const future = JSON.stringify({ version: 2, tasks: [], timer: { status: 'idle' }, boards: [] })
  writeFileSync(tasksFile, future)
  try {
    const app = await launchTaskyard(profile)
    const page = await app.firstWindow()

    await expect(page.getByRole('alert')).toContainText('Read-only mode')
    const result = await page.evaluate(async () => {
      const { taskyard } = globalThis as unknown as BridgeWindow
      const { revision, data } = await taskyard.storage.load('tasks')
      return taskyard.storage.save('tasks', {
        baseRevision: revision,
        data: { ...data, tasks: [] }
      })
    })
    expect(result).toEqual({ ok: false, reason: 'read-only' })
    await app.close()

    expect(readFileSync(tasksFile, 'utf8')).toBe(future)
    expect(existsSync(`${tasksFile}.bak`)).toBe(false)
  } finally {
    profile.dispose()
  }
})

test('app:openExternal refuses a URL outside the allow-list in main', async () => {
  const profile = createProfile()
  try {
    const app = await launchTaskyard(profile)
    const page = await app.firstWindow()

    const outcome = await page.evaluate(async () => {
      const { taskyard } = globalThis as unknown as BridgeWindow
      try {
        await taskyard.app.openExternal('file:///C:/Windows/System32/cmd.exe')
        return 'opened'
      } catch (error) {
        return String(error)
      }
    })
    expect(outcome).toContain('invalid arguments for app:openExternal')
    await app.close()
  } finally {
    profile.dispose()
  }
})

test('a save is echoed to its own window, and a save built on an old revision is refused', async () => {
  const profile = createProfile()
  try {
    const app = await launchTaskyard(profile)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    const outcome = await page.evaluate(async () => {
      const { taskyard } = globalThis as unknown as BridgeWindow
      const echoed = new Promise<unknown>((resolve) => {
        const off = taskyard.on('storage:changed', (change) => {
          if (change.store !== 'settings') return
          off()
          resolve(change)
        })
      })
      const { revision, data } = await taskyard.storage.load('settings')
      const first = await taskyard.storage.save('settings', {
        baseRevision: revision,
        data: { ...data, accent: 'purple' }
      })
      const stale = await taskyard.storage.save('settings', {
        baseRevision: revision,
        data: { ...data, accent: 'white' }
      })
      return { first, stale, echo: await echoed }
    })

    expect(outcome.first).toEqual({ ok: true, revision: 2 })
    expect(outcome.echo).toMatchObject({
      store: 'settings',
      revision: 2,
      data: { accent: 'purple' }
    })
    expect(outcome.stale).toMatchObject({
      ok: false,
      reason: 'stale',
      revision: 2,
      data: { accent: 'purple' }
    })
    await app.close()

    expect(readJson(join(profile.userData, 'settings.json'))).toMatchObject({ accent: 'purple' })
  } finally {
    profile.dispose()
  }
})
