// Two renderer windows — each the sync client the layout store is built on, applying the same
// layout mutations — against the real main-side storage, handlers, broadcast and disk, with
// replies and events delivered in adversarial orders. Proves the optimistic-concurrency protocol
// keeps disk and every window identical and loses no one's edit.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyLayout } from '@shared/defaults'
import type { SaveResult, StorageChanged, StoreSnapshot } from '@shared/ipc'
import { ensureDisplay, putGroup } from '@shared/layout-mutations'
import type { Group, LayoutFile } from '@shared/schema'
import { createSyncedDoc, type SyncedDoc } from '@shared/sync-doc'
import { createStorage, type Storage } from '../storage/stores'
import { createEventEmitter, type WebContentsLike } from './events'
import { FakeIpcMain, trustedEvent } from './fake-ipc-main'
import { registerIpcHandlers } from './handlers'

const PRIMARY = { x: 0, y: 0, width: 2560, height: 1440 }
const SECONDARY = { x: 2560, y: 0, width: 1920, height: 1080 }

interface Delivery {
  label: string
  deliver(): void
}

interface TestWindow {
  id: number
  inbox: Delivery[]
  contents: WebContentsLike
  doc: SyncedDoc<LayoutFile>
}

type Order = 'fifo' | 'lifo'

let dir: string
let storage: Storage
let ipc: FakeIpcMain
let windows: TestWindow[]

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function openWindow(id: number): TestWindow {
  const inbox: Delivery[] = []
  const doc = createSyncedDoc<LayoutFile>({
    initial: emptyLayout(),
    transport: {
      // Main handles the request when it arrives; the reply's delivery is up to the test.
      save: (request) =>
        ipc.invokeFrom(trustedEvent(id), 'storage:save', 'layout', request).then(
          (result) =>
            new Promise<SaveResult<'layout'>>((resolve) =>
              inbox.push({
                label: 'reply',
                deliver: () => resolve(result as SaveResult<'layout'>)
              })
            )
        )
    },
    onView: () => {},
    onError: (error) => {
      throw error
    }
  })
  const contents: WebContentsLike = {
    id,
    isDestroyed: () => false,
    send(channel, payload) {
      const change = payload as StorageChanged
      if (channel !== 'storage:changed' || change.store !== 'layout') return
      inbox.push({
        label: `event r${change.revision}`,
        deliver: () => doc.receive({ revision: change.revision, data: change.data })
      })
    }
  }
  return { id, inbox, contents, doc }
}

/** Delivers every queued reply and event, alternating windows, until nothing moves. */
async function settle(order: Order): Promise<void> {
  for (let step = 0; step < 200; step++) {
    await tick()
    const busy = windows.filter((window) => window.inbox.length > 0)
    if (busy.length === 0) return
    const window = busy[step % busy.length]
    const delivery = order === 'fifo' ? window.inbox.shift() : window.inbox.pop()
    delivery?.deliver()
  }
  throw new Error('the windows never settled')
}

async function disk(): Promise<LayoutFile> {
  await storage.flushAll()
  return JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')) as LayoutFile
}

function group(id: string): Group {
  return {
    id,
    title: id,
    x: 40,
    y: 40,
    w: 280,
    h: 200,
    z: 1,
    rolledUp: false,
    items: [],
    sort: 'manual',
    excludeFromQuickHide: false,
    createdAt: 1
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'taskyard-sync-'))
  windows = [openWindow(1), openWindow(2)]
  const events = createEventEmitter(() => windows.map((window) => window.contents), {
    warn: vi.fn()
  })
  storage = createStorage({
    dir,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onChange: (change) => events.emit('storage:changed', change)
  })
  await storage.loadAll()
  ipc = new FakeIpcMain()
  registerIpcHandlers(ipc, {
    storage,
    isTrustedSender: () => true,
    openExternal: async () => {},
    quit: () => {},
    log: { warn: vi.fn() }
  })
  for (const window of windows) {
    const snapshot = await ipc.invokeFrom(trustedEvent(window.id), 'storage:load', 'layout')
    window.doc.receive(snapshot as StoreSnapshot<'layout'>)
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('two windows saving the layout at the same time', () => {
  it.each<Order>(['fifo', 'lifo'])(
    'both add their display on first run: disk and both windows end with both displays (%s)',
    async (order) => {
      const [a, b] = windows
      // Each window adds its own display before it has seen the other's save.
      a.doc.mutate((layout) => ensureDisplay(layout, { id: 101, bounds: PRIMARY }))
      b.doc.mutate((layout) => ensureDisplay(layout, { id: 202, bounds: SECONDARY }))

      await settle(order)

      const saved = await disk()
      expect(saved.displays.map((display) => display.displayId).sort()).toEqual([101, 202])
      expect(a.doc.view).toEqual(saved)
      expect(b.doc.view).toEqual(saved)
      expect(storage.layout.get()).toEqual(saved)
    }
  )

  it.each<Order>(['fifo', 'lifo'])(
    'groups added on both displays at once are all kept (%s)',
    async (order) => {
      const [a, b] = windows
      a.doc.mutate((layout) => ensureDisplay(layout, { id: 101, bounds: PRIMARY }))
      await settle(order)
      b.doc.mutate((layout) => ensureDisplay(layout, { id: 202, bounds: SECONDARY }))
      await settle(order)

      a.doc.mutate((layout) => putGroup(layout, 101, group('apps')))
      b.doc.mutate((layout) => putGroup(layout, 202, group('docs')))
      a.doc.mutate((layout) => putGroup(layout, 101, group('games')))
      await settle(order)

      const saved = await disk()
      const groups = Object.fromEntries(
        saved.displays.map((display) => [display.displayId, display.groups.map((g) => g.id)])
      )
      expect(groups).toEqual({ 101: ['apps', 'games'], 202: ['docs'] })
      expect(a.doc.view).toEqual(saved)
      expect(b.doc.view).toEqual(saved)
    }
  )

  it('the sender gets its own save back as an event and does not apply it twice', async () => {
    const [a] = windows
    a.doc.mutate((layout) => ensureDisplay(layout, { id: 101, bounds: PRIMARY }))
    await tick()

    expect(a.inbox.map((delivery) => delivery.label)).toEqual(['event r2', 'reply'])
    await settle('fifo')

    expect(a.doc.view.displays).toHaveLength(1)
    expect(a.doc.revision).toBe(2)
    expect(storage.layout.snapshot().revision).toBe(2)
  })
})
