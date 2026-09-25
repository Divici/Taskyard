import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { TaskyardApi } from '../src/preload/api'
import { writeLnk } from '../src/main/desktop/test/lnk-writer'
import { createProfile, launchTaskyard } from './helpers/taskyard'

type Recorded = Array<[string, unknown]>
type BridgeWindow = { taskyard: TaskyardApi; recorded: Recorded }

const idOf = (path: string): string => {
  const stats = statSync(path, { bigint: true })
  return `${stats.dev}:${stats.ino}`
}

/** Records, in the page, the desktop events and every layout paths change main broadcasts. */
function record(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = globalThis as unknown as BridgeWindow
    w.recorded = []
    w.taskyard.on('desktop:changed', (change) => w.recorded.push(['changed', change]))
    w.taskyard.on('desktop:renamed', (renamed) => w.recorded.push(['renamed', renamed]))
    w.taskyard.on('storage:changed', (changed) => {
      if (changed.store === 'layout') w.recorded.push(['layout', changed.data.paths])
    })
  })
}

const recorded = (page: Page): Promise<Recorded> =>
  page.evaluate(() => (globalThis as unknown as BridgeWindow).recorded)

const loadLayout = (
  page: Page
): Promise<{ revision: number; data: { paths: Record<string, string>; displays: unknown[] } }> =>
  page.evaluate(() =>
    (globalThis as unknown as BridgeWindow).taskyard.storage.load('layout')
  ) as Promise<{ revision: number; data: { paths: Record<string, string>; displays: unknown[] } }>

test('lists a temp desktop, renames through IPC and in "Explorer", and follows adds and removals', async () => {
  const profile = createProfile()
  const desktop = profile.desktop
  writeFileSync(join(desktop, 'a.txt'), 'a')
  writeFileSync(join(desktop, 'b.txt'), 'b')
  mkdirSync(join(desktop, 'Folder'))
  writeFileSync(join(desktop, 'Tool.lnk'), writeLnk({ localBasePath: 'C:\\Windows\\notepad.exe' }))
  writeFileSync(join(desktop, 'Site.url'), '[InternetShortcut]\r\nURL=https://example.com/\r\n')
  const a = idOf(join(desktop, 'a.txt'))
  const b = idOf(join(desktop, 'b.txt'))
  // Both items are known to the layout (placed earlier), so their paths must follow renames.
  writeFileSync(
    join(profile.userData, 'layout.json'),
    JSON.stringify({
      version: 1,
      displays: [],
      paths: { [a]: join(desktop, 'a.txt'), [b]: join(desktop, 'b.txt') },
      lastSeen: {}
    })
  )

  const app = await launchTaskyard(profile)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // The renderer's items store is hydrated from desktop:list.
    await expect(page.locator('main')).toHaveAttribute('data-desktop-items', '5')
    const listed = await page.evaluate(() =>
      (globalThis as unknown as BridgeWindow).taskyard.desktop.list()
    )
    expect(listed.map((item) => item.name).sort()).toEqual(['Folder', 'Site', 'Tool', 'a', 'b'])
    expect(listed.find((item) => item.name === 'Tool')).toMatchObject({
      kind: 'link',
      targetPath: 'C:\\Windows\\notepad.exe',
      targetRemote: false
    })
    expect(listed.find((item) => item.name === 'Site')?.url).toBe('https://example.com/')
    expect(profile.readLog()).toMatch(/scan: 5 items in \d+ ms \(0 readonly, 0 placeholders\)/)

    // Let every window register its display, so the only layout saves left are ours.
    const displayCount = await app.evaluate(({ screen }) => screen.getAllDisplays().length)
    await expect.poll(async () => (await loadLayout(page)).data.displays.length).toBe(displayCount)
    await page.waitForTimeout(500)
    await record(page)
    const before = await loadLayout(page)

    // 1. Taskyard's rename (desktop:rename).
    const result = await page.evaluate(
      (id) => (globalThis as unknown as BridgeWindow).taskyard.desktop.rename(id, 'renamed.txt'),
      a
    )
    expect(result).toEqual({ ok: true, path: join(desktop, 'renamed.txt') })
    await page.waitForTimeout(1_500) // the watcher sees the rename too; it must change nothing more
    let events = await recorded(page)
    expect(events.filter(([kind]) => kind === 'renamed')).toEqual([
      ['renamed', { id: a, path: join(desktop, 'renamed.txt') }]
    ])
    expect(events.filter(([kind]) => kind === 'layout')).toHaveLength(1)
    expect(events.filter(([kind]) => kind === 'changed')).toHaveLength(0)
    const afterOurs = await loadLayout(page)
    expect(afterOurs.revision).toBe(before.revision + 1)
    expect(afterOurs.data.paths[a]).toBe(join(desktop, 'renamed.txt'))
    expect(readdirSync(desktop).sort()).toEqual([
      'Folder',
      'Site.url',
      'Tool.lnk',
      'b.txt',
      'renamed.txt'
    ])

    // 2. A rename outside Taskyard (as Explorer does it): the watcher pairs unlink + add by id.
    renameSync(join(desktop, 'b.txt'), join(desktop, 'b from explorer.txt'))
    await expect
      .poll(async () => (await recorded(page)).filter(([kind]) => kind === 'renamed').length)
      .toBe(2)
    await page.waitForTimeout(1_000)
    events = await recorded(page)
    expect(events.filter(([kind]) => kind === 'renamed')[1]).toEqual([
      'renamed',
      { id: b, path: join(desktop, 'b from explorer.txt') }
    ])
    expect(events.filter(([kind]) => kind === 'layout')).toHaveLength(2)
    expect(events.filter(([kind]) => kind === 'changed')).toHaveLength(0)
    expect((await loadLayout(page)).data.paths[b]).toBe(join(desktop, 'b from explorer.txt'))

    // 3. A file added, then removed, outside Taskyard.
    writeFileSync(join(desktop, 'new.txt'), 'hello')
    await expect(page.locator('main')).toHaveAttribute('data-desktop-items', '6')
    const added = idOf(join(desktop, 'new.txt'))
    unlinkSync(join(desktop, 'new.txt'))
    await expect(page.locator('main')).toHaveAttribute('data-desktop-items', '5')
    const changes = (await recorded(page))
      .filter(([kind]) => kind === 'changed')
      .map(([, change]) => change)
    expect(changes).toEqual([
      {
        added: [expect.objectContaining({ id: added, name: 'new', sizeBytes: 5 })],
        removed: [],
        changed: []
      },
      { added: [], removed: [added], changed: [] }
    ])
    expect(profile.readLog()).not.toContain('ipc: rejected')
  } finally {
    await app.close()
    profile.dispose()
  }
})
