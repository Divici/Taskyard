import { describe, expect, it, vi } from 'vitest'
import { emptyLayout, newDisplayLayout } from '@shared/defaults'
import { renamePath } from '@shared/layout-mutations'
import { PRUNE_AFTER_MS } from '@shared/placement'
import type { Group, LayoutFile } from '@shared/schema'
import { installFakeBridge } from '../test/fake-bridge'
import { FakeMain, tick } from '@shared/test/fake-main'
import { clampGroupInto, createLayoutStore } from './layout'
import { useUiStore } from './ui'

const PRIMARY = { x: 0, y: 0, width: 2560, height: 1440 }
const SECONDARY = { x: 2560, y: 0, width: 1920, height: 1080 }

function group(id: string, patch: Partial<Group> = {}): Group {
  return {
    id,
    title: 'Apps',
    x: 40,
    y: 40,
    w: 280,
    h: 200,
    z: 1,
    rolledUp: false,
    items: ['1:2'],
    sort: 'manual',
    excludeFromQuickHide: false,
    createdAt: 1_758_600_000_000,
    ...patch
  }
}

function withDisplay(): LayoutFile {
  return { ...emptyLayout(), displays: [newDisplayLayout(1, PRIMARY)] }
}

/** Lets every pending promise and zero-delay timer run, so a late save or toast would show. */
async function drain(): Promise<void> {
  for (let n = 0; n < 5; n++) await tick()
}

describe('layout store', () => {
  it('addGroup persists via mocked bridge', async () => {
    const bridge = installFakeBridge()
    const store = createLayoutStore()
    store.getState().receive({ revision: 1, data: withDisplay() })

    store.getState().addGroup(1, group('g-1'))

    const layout = store.getState().layout
    expect(layout.displays[0].groups).toEqual([group('g-1')])
    await vi.waitFor(() =>
      expect(bridge.storage.save).toHaveBeenCalledExactlyOnceWith('layout', {
        baseRevision: 1,
        data: layout
      })
    )
  })

  it('appends groups without disturbing the others', () => {
    installFakeBridge()
    const store = createLayoutStore()
    store.getState().receive({ revision: 1, data: withDisplay() })

    store.getState().addGroup(1, group('g-1'))
    store.getState().addGroup(1, group('g-2', { z: 2 }))

    expect(store.getState().layout.displays[0].groups.map((g) => g.id)).toEqual(['g-1', 'g-2'])
  })

  it('only creates: adding an existing group id again changes nothing and returns false', () => {
    installFakeBridge()
    const store = createLayoutStore()
    store.getState().receive({ revision: 1, data: withDisplay() })

    expect(store.getState().addGroup(1, group('g-1'))).toBe(true)
    expect(store.getState().addGroup(1, group('g-1', { title: 'Renamed' }))).toBe(false)

    expect(store.getState().layout.displays[0].groups).toEqual([group('g-1')])
  })

  it('updateGroup, setLoosePosition and updateTools change single fields and persist', async () => {
    const bridge = installFakeBridge()
    const store = createLayoutStore()
    store.getState().receive({ revision: 1, data: withDisplay() })
    store.getState().addGroup(1, group('g-1'))

    store.getState().updateGroup(1, 'g-1', (g) => ({ ...g, rolledUp: true }))
    store.getState().setLoosePosition(1, '5:6', { x: 8, y: 8 })
    store.getState().updateTools(1, (tools) => ({ ...tools, activeTool: 'timer' }))
    await drain()

    const display = store.getState().layout.displays[0]
    expect(display.groups[0].rolledUp).toBe(true)
    expect(display.loose).toEqual({ '5:6': { x: 8, y: 8 } })
    expect(display.tools.activeTool).toBe('timer')
    expect(bridge.storage.save.mock.calls.at(-1)?.[1].data).toEqual(store.getState().layout)
  })

  it('two windows editing different fields of one group at once keep both edits', async () => {
    const start = {
      ...withDisplay(),
      displays: [{ ...newDisplayLayout(1, PRIMARY), groups: [group('g')] }]
    }
    const main = new FakeMain<LayoutFile>(start)
    const [a, b] = [main.connect(), main.connect()].map((window) => {
      const store = createLayoutStore({ transport: window.transport })
      window.receive = (snapshot) => store.getState().receive(snapshot)
      store.getState().receive(main.snapshot())
      return store
    })

    a.getState().updateGroup(1, 'g', (g) => ({ ...g, title: 'Projects' }))
    b.getState().updateGroup(1, 'g', (g) => ({ ...g, x: 600, y: 320 }))
    await main.settle('lifo')

    expect(main.data.displays[0].groups[0]).toMatchObject({ title: 'Projects', x: 600, y: 320 })
    expect(a.getState().layout).toEqual(main.data)
    expect(b.getState().layout).toEqual(main.data)
  })

  describe('two windows at once, on display-level changes', () => {
    function windowsOn(start: LayoutFile): {
      main: FakeMain<LayoutFile>
      a: ReturnType<typeof createLayoutStore>
      b: ReturnType<typeof createLayoutStore>
    } {
      const main = new FakeMain<LayoutFile>(start)
      const [a, b] = [main.connect(), main.connect()].map((window) => {
        const store = createLayoutStore({ transport: window.transport })
        window.receive = (snapshot) => store.getState().receive(snapshot)
        store.getState().receive(main.snapshot())
        return store
      })
      return { main, a, b }
    }

    function display(...groups: Group[]): LayoutFile {
      return { ...withDisplay(), displays: [{ ...newDisplayLayout(1, PRIMARY), groups }] }
    }

    function setLooseIn(layout: LayoutFile, fileId: string): LayoutFile {
      const [first, ...rest] = layout.displays
      return {
        ...layout,
        displays: [{ ...first, loose: { [fileId]: { x: 800, y: 40 } } }, ...rest]
      }
    }

    it.each(['fifo', 'lifo'] as const)(
      'bringing different groups to front gives them distinct z above the rest (%s)',
      async (order) => {
        const { main, a, b } = windowsOn(
          display(group('x', { z: 1 }), group('y', { z: 2 }), group('top', { z: 5 }))
        )

        a.getState().bringGroupToFront(1, 'x')
        b.getState().bringGroupToFront(1, 'y')
        await main.settle(order)

        const z = Object.fromEntries(main.data.displays[0].groups.map((g) => [g.id, g.z]))
        expect(new Set(Object.values(z)).size).toBe(3)
        expect(Math.min(z.x, z.y)).toBeGreaterThan(z.top)
        expect(a.getState().layout).toEqual(main.data)
        expect(b.getState().layout).toEqual(main.data)
      }
    )

    it.each(['fifo', 'lifo'] as const)(
      'moving the same item to different groups leaves it in exactly one place (%s)',
      async (order) => {
        const { main, a, b } = windowsOn(
          display(
            group('from', { items: ['7:7'] }),
            group('left', { items: [] }),
            group('right', { items: [] })
          )
        )

        a.getState().moveItems(1, ['7:7'], { groupId: 'left' })
        b.getState().moveItems(1, ['7:7'], { groupId: 'right' })
        await main.settle(order)

        const places = main.data.displays[0].groups.filter((g) => g.items.includes('7:7'))
        expect(places).toHaveLength(1)
        expect(main.data.displays[0].loose).toEqual({})
        expect(a.getState().layout).toEqual(main.data)
        expect(b.getState().layout).toEqual(main.data)
      }
    )

    it.each(['fifo', 'lifo'] as const)(
      'an item dropped before an anchor stays before it when another window inserts into the group (%s)',
      async (order) => {
        const start = setLooseIn(
          display(group('from', { items: ['5:5'] }), group('g', { items: ['1:1', '1:2'] })),
          '6:6'
        )
        const { main, a, b } = windowsOn(start)

        a.getState().moveItems(1, ['5:5'], { groupId: 'g', beforeId: '1:2' })
        b.getState().moveItems(1, ['6:6'], { groupId: 'g', beforeId: '1:1' })
        await main.settle(order)

        expect(main.data.displays[0].groups[1].items).toEqual(['6:6', '1:1', '5:5', '1:2'])
        expect(a.getState().layout).toEqual(main.data)
        expect(b.getState().layout).toEqual(main.data)
      }
    )

    it.each(['fifo', 'lifo'] as const)(
      'an item added to a group while another window deletes the group ends up loose, not lost (%s)',
      async (order) => {
        const start = setLooseIn(display(group('doomed', { x: 100, y: 50, items: ['1:1'] })), '8:8')
        const { main, a, b } = windowsOn(start)

        a.getState().moveItems(1, ['8:8'], { groupId: 'doomed' })
        b.getState().deleteGroup(1, 'doomed')
        await main.settle(order)

        const shown = main.data.displays[0]
        expect(shown.groups).toEqual([])
        expect(Object.keys(shown.loose).sort()).toEqual(['1:1', '8:8'])
        expect(a.getState().layout).toEqual(main.data)
        expect(b.getState().layout).toEqual(main.data)
      }
    )

    it.each(['fifo', 'lifo'] as const)(
      'a group renamed in one window while another moves it to a second display keeps the name (%s)',
      async (order) => {
        const start = {
          ...display(group('g', { x: 2400, y: 1300 })),
          displays: [
            { ...newDisplayLayout(1, PRIMARY), groups: [group('g', { x: 2400, y: 1300 })] },
            newDisplayLayout(2, SECONDARY)
          ]
        }
        const { main, a, b } = windowsOn(start)
        const clamp = (rect: { x: number; y: number; w: number; h: number }): typeof rect => ({
          ...rect,
          x: Math.min(rect.x, 1920 - rect.w),
          y: Math.min(rect.y, 1080 - rect.h)
        })

        a.getState().updateGroup(1, 'g', (g) => ({ ...g, title: 'Projects' }))
        b.getState().moveGroupToDisplay(1, 'g', 2, clamp)
        await main.settle(order)

        expect(main.data.displays[0].groups).toEqual([])
        expect(main.data.displays[1].groups).toEqual([
          expect.objectContaining({ id: 'g', title: 'Projects', x: 1640, y: 880 })
        ])
        expect(a.getState().layout).toEqual(main.data)
        expect(b.getState().layout).toEqual(main.data)
      }
    )

    it('updateDisplay changes the display with an updater and persists', async () => {
      const { main, a } = windowsOn(display())

      a.getState().updateDisplay(1, (d) => ({ ...d, bounds: SECONDARY }))
      await main.settle()

      expect(main.data.displays[0].bounds).toEqual(SECONDARY)
    })
  })

  it('snapshots every argument when called, so changing it afterwards cannot change a replay', async () => {
    const bridge = installFakeBridge()
    const store = createLayoutStore()
    const bounds = { ...SECONDARY }
    const created = group('g-new')
    const point = { x: 10, y: 20 }
    const target = { loose: [{ x: 30, y: 40 }] }
    const ids = ['4:4']

    // Before hydration, so each change is replayed later on the loaded layout.
    store.getState().ensureDisplay({ id: 2, bounds })
    store.getState().setLoosePosition(1, '3:3', point)
    store.getState().moveItems(1, ids, target)
    bounds.width = 1
    point.x = 999
    target.loose[0].x = 999
    target.loose.push({ x: 0, y: 0 })
    ids.push('5:5')
    store.getState().receive({ revision: 1, data: withDisplay() })
    store.getState().addGroup(2, created)
    created.title = 'changed later'
    await drain()

    const saved = bridge.storage.save.mock.calls.at(-1)?.[1].data as LayoutFile | undefined
    expect(saved?.displays[1].bounds).toEqual(SECONDARY)
    expect(saved?.displays[0].loose).toEqual({ '3:3': { x: 10, y: 20 }, '4:4': { x: 30, y: 40 } })
    expect(saved?.displays[1].groups[0].title).toBe('Apps')
  })

  it('reset() stops the old copy: a queued save is never sent and a late reply changes nothing', async () => {
    const bridge = installFakeBridge()
    let release!: (value: { ok: true; revision: number }) => void
    bridge.storage.save.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve as typeof release))
    )
    const store = createLayoutStore()
    store.getState().receive({ revision: 1, data: withDisplay() })
    store.getState().addGroup(1, group('in-flight'))
    await drain()
    store.getState().addGroup(1, group('queued'))

    store.getState().reset()
    release({ ok: true, revision: 2 })
    await drain()

    expect(bridge.storage.save).toHaveBeenCalledOnce()
    expect(store.getState()).toMatchObject({ layout: emptyLayout(), hydrated: false })
    expect(useUiStore.getState().toasts).toEqual([])
  })

  it('does nothing and saves nothing for an unknown display', async () => {
    const bridge = installFakeBridge()
    const store = createLayoutStore()
    store.getState().receive({ revision: 1, data: withDisplay() })

    expect(store.getState().addGroup(99, group('g-1'))).toBe(false)
    await drain()
    expect(bridge.storage.save).not.toHaveBeenCalled()
  })

  it('receive() replaces the layout without saving it back', async () => {
    const bridge = installFakeBridge()
    const store = createLayoutStore()

    store.getState().receive({ revision: 3, data: withDisplay() })

    expect(store.getState().hydrated).toBe(true)
    expect(store.getState().layout).toEqual(withDisplay())
    await drain()
    expect(bridge.storage.save).not.toHaveBeenCalled()
  })

  it('applies a change made before hydration to the saved layout, never to the defaults', async () => {
    const bridge = installFakeBridge()
    const store = createLayoutStore()

    store.getState().ensureDisplay({ id: 2, bounds: SECONDARY })
    await drain()
    expect(bridge.storage.save).not.toHaveBeenCalled()

    const saved = {
      ...withDisplay(),
      displays: [{ ...newDisplayLayout(1, PRIMARY), groups: [group('g')] }]
    }
    store.getState().receive({ revision: 1, data: saved })

    const expected = { ...saved, displays: [...saved.displays, newDisplayLayout(2, SECONDARY)] }
    expect(store.getState().layout).toEqual(expected)
    await vi.waitFor(() =>
      expect(bridge.storage.save).toHaveBeenCalledExactlyOnceWith('layout', {
        baseRevision: 1,
        data: expected
      })
    )
  })

  it('ensureDisplay adds a display once and refreshes its bounds', async () => {
    const bridge = installFakeBridge()
    const store = createLayoutStore()
    store.getState().receive({ revision: 1, data: emptyLayout() })

    store.getState().ensureDisplay({ id: 7, bounds: PRIMARY })
    store.getState().ensureDisplay({ id: 7, bounds: PRIMARY })
    await drain()
    store.getState().ensureDisplay({ id: 7, bounds: SECONDARY })
    await drain()

    expect(store.getState().layout.displays).toEqual([newDisplayLayout(7, SECONDARY)])
    expect(bridge.storage.save.mock.calls.map(([, request]) => request.baseRevision)).toEqual([
      1, 2
    ])
    expect(bridge.storage.save.mock.calls.at(-1)?.[1].data).toEqual(store.getState().layout)
  })

  it('sends changes made in one go as a single save', async () => {
    const bridge = installFakeBridge()
    const store = createLayoutStore()
    store.getState().receive({ revision: 1, data: withDisplay() })

    store.getState().addGroup(1, group('g-1'))
    store.getState().addGroup(1, group('g-2'))
    await drain()

    expect(bridge.storage.save).toHaveBeenCalledOnce()
  })

  it('two stores adding their displays at once both keep both displays', async () => {
    const main = new FakeMain<LayoutFile>(emptyLayout())
    const [a, b] = [main.connect(), main.connect()].map((window) => {
      const store = createLayoutStore({ transport: window.transport })
      window.receive = (snapshot) => store.getState().receive(snapshot)
      store.getState().receive(main.snapshot())
      return store
    })

    a.getState().ensureDisplay({ id: 1, bounds: PRIMARY })
    b.getState().ensureDisplay({ id: 2, bounds: SECONDARY })
    await main.settle('lifo')

    expect(main.data.displays.map((display) => display.displayId).sort()).toEqual([1, 2])
    expect(a.getState().layout).toEqual(main.data)
    expect(b.getState().layout).toEqual(main.data)
  })

  it('undoes a change main rejected and says so with an error toast', async () => {
    const bridge = installFakeBridge()
    bridge.storage.save.mockRejectedValueOnce(new Error('invalid arguments for storage:save'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createLayoutStore()
    store.getState().receive({ revision: 1, data: withDisplay() })

    store.getState().addGroup(1, group('g-1'))

    await vi.waitFor(() =>
      expect(useUiStore.getState().toasts).toEqual([
        expect.objectContaining({
          id: 'save-failed:layout',
          tone: 'error',
          message: 'Couldn’t save your desktop layout.'
        })
      ])
    )
    expect(store.getState().layout).toEqual(withDisplay())
  })

  it('stays quiet when main refuses a save because the file is read-only', async () => {
    const bridge = installFakeBridge()
    bridge.storage.save.mockResolvedValue({ ok: false, reason: 'read-only' })
    const store = createLayoutStore()
    store.getState().receive({ revision: 1, data: withDisplay() })

    store.getState().addGroup(1, group('g-1'))
    await drain()

    expect(bridge.storage.save).toHaveBeenCalledOnce()
    expect(useUiStore.getState().toasts).toEqual([])
    expect(store.getState().layout.displays[0].groups).toHaveLength(1)
  })
  describe('Phase 7 actions', () => {
    const AREA = { x: 0, y: 0, width: 400, height: 300 }
    const CELL = { width: 100, height: 100 }
    const PLACE = { displayId: 1, area: AREA, cell: CELL }
    const NOW = 1_760_000_000_000
    const item = (id: string, name = id): { id: string; name: string; path: string } => ({
      id,
      name,
      path: `C:\\D\\${name}`
    })

    function hydrated(data: LayoutFile = withDisplay()): {
      bridge: ReturnType<typeof installFakeBridge>
      store: ReturnType<typeof createLayoutStore>
    } {
      const bridge = installFakeBridge()
      const store = createLayoutStore()
      store.getState().receive({ revision: 1, data })
      return { bridge, store }
    }

    function placed(ids: Record<string, { x: number; y: number }>): LayoutFile {
      const layout = withDisplay()
      layout.displays[0].loose = ids
      layout.paths = Object.fromEntries(Object.keys(ids).map((id) => [id, `C:\\D\\${id}`]))
      return layout
    }

    it('reconcile hides a missing id and stamps lastSeen (placement kept)', async () => {
      const { bridge, store } = hydrated(placed({ '1:1': { x: 0, y: 0 } }))

      store.getState().reconcile([], { now: NOW, place: PLACE })

      const layout = store.getState().layout
      expect(layout.lastSeen).toEqual({ '1:1': NOW })
      expect(layout.displays[0].loose).toEqual({ '1:1': { x: 0, y: 0 } })
      await vi.waitFor(() => expect(bridge.storage.save).toHaveBeenCalledOnce())
    })

    it('reconcile clears lastSeen when the id returns', () => {
      const start = placed({ '1:1': { x: 0, y: 0 } })
      start.lastSeen = { '1:1': NOW - 1000 }
      const { store } = hydrated(start)

      store.getState().reconcile([item('1:1')], { now: NOW, place: PLACE })

      expect(store.getState().layout.lastSeen).toEqual({})
    })

    it('reconcile prunes an id missing for more than 30 days', () => {
      const start = placed({ '1:1': { x: 0, y: 0 } })
      start.lastSeen = { '1:1': NOW - PRUNE_AFTER_MS - 1 }
      const { store } = hydrated(start)

      store.getState().reconcile([], { now: NOW, place: PLACE })

      const layout = store.getState().layout
      expect(layout.displays[0].loose).toEqual({})
      expect(layout.paths).toEqual({})
      expect(layout.lastSeen).toEqual({})
    })

    it('reconcile places new ids on the primary display, column-first, and records their paths', () => {
      const start = withDisplay()
      start.displays.push(newDisplayLayout(2, SECONDARY))
      const { store } = hydrated(start)

      store.getState().reconcile([item('1:2', 'b'), item('1:1', 'a')], { now: NOW, place: PLACE })

      const layout = store.getState().layout
      expect(layout.displays[0].loose).toEqual({ '1:1': { x: 0, y: 0 }, '1:2': { x: 0, y: 100 } })
      expect(layout.displays[1].loose).toEqual({})
      expect(layout.paths).toEqual({ '1:1': 'C:\\D\\a', '1:2': 'C:\\D\\b' })
    })

    it('reconcile saves nothing when the layout already agrees', async () => {
      const { bridge, store } = hydrated(placed({ '1:1': { x: 0, y: 0 } }))
      store.getState().reconcile([item('1:1')], { now: NOW, place: PLACE })
      await drain()
      expect(bridge.storage.save).not.toHaveBeenCalled()
    })

    it('placeNewItems puts only unplaced ids in free cells', () => {
      const { store } = hydrated(placed({ '1:1': { x: 0, y: 0 } }))
      store.getState().placeNewItems([item('1:1'), item('1:9')], PLACE)
      expect(store.getState().layout.displays[0].loose).toEqual({
        '1:1': { x: 0, y: 0 },
        '1:9': { x: 0, y: 100 }
      })
    })

    it('resetLayout (Phase 11) clears every group and position, then lays the icons out again', async () => {
      const start = placed({ '1:1': { x: 300, y: 200 }, '1:2': { x: 0, y: 0 } })
      start.displays[0].groups = [group('g', { items: ['1:3'] })]
      start.displays.push({ ...newDisplayLayout(2, SECONDARY), loose: { '1:4': { x: 8, y: 8 } } })
      const { bridge, store } = hydrated(start)

      store
        .getState()
        .resetLayout(
          [item('1:2', 'b'), item('1:1', 'a'), item('1:3', 'c'), item('1:4', 'd')],
          PLACE
        )

      const layout = store.getState().layout
      expect(layout.displays[0].groups).toEqual([])
      expect(layout.displays[0].loose).toEqual({
        '1:1': { x: 0, y: 0 },
        '1:2': { x: 0, y: 100 },
        '1:3': { x: 0, y: 200 },
        '1:4': { x: 100, y: 0 }
      })
      expect(layout.displays[1].loose).toEqual({})
      // One change, one save.
      await vi.waitFor(() => expect(bridge.storage.save).toHaveBeenCalledOnce())
    })

    it('onRenamed (main’s renamePath) updates one path entry and nothing else', () => {
      const start = placed({ '1:1': { x: 0, y: 0 }, '1:2': { x: 0, y: 100 } })
      const next = renamePath(start, '1:1', 'C:\\D\\renamed.txt')
      expect(next.paths).toEqual({ '1:1': 'C:\\D\\renamed.txt', '1:2': 'C:\\D\\1:2' })
      expect(next.displays).toBe(start.displays)
    })

    it('moveGroupToDisplay clamps the group into the target work area', () => {
      const start = withDisplay()
      start.displays[0].groups = [group('g', { x: 2300, y: 1300, w: 400, h: 300 })]
      start.displays.push(newDisplayLayout(2, SECONDARY))
      const { store } = hydrated(start)
      const target = { x: 0, y: 0, width: 1920, height: 1032 }

      store.getState().moveGroupToDisplay(1, 'g', 2, clampGroupInto(target))

      const layout = store.getState().layout
      expect(layout.displays[0].groups).toEqual([])
      expect(layout.displays[1].groups[0]).toMatchObject({ x: 1520, y: 732, w: 400, h: 300 })
    })

    it('createGroup adds a group on top at the rect, captures the given items, in one save', async () => {
      const start = placed({ '1:1': { x: 0, y: 0 }, '1:2': { x: 0, y: 100 } })
      start.displays[0].groups = [group('old', { z: 4, items: [] })]
      const { bridge, store } = hydrated(start)

      const id = store.getState().createGroup(1, { x: 40, y: 48, width: 280, height: 200 }, ['1:2'])

      const created = store.getState().layout.displays[0].groups.find((g) => g.id === id)
      expect(created).toMatchObject({
        title: 'New group',
        x: 40,
        y: 48,
        w: 280,
        h: 200,
        z: 5,
        items: ['1:2'],
        rolledUp: false,
        sort: 'manual'
      })
      expect(store.getState().layout.displays[0].loose).toEqual({ '1:1': { x: 0, y: 0 } })
      await drain()
      expect(bridge.storage.save).toHaveBeenCalledOnce()
    })

    it('createGroup returns null for a display without an entry', () => {
      const { store } = hydrated()
      expect(store.getState().createGroup(9, { x: 0, y: 0, width: 280, height: 200 })).toBeNull()
    })

    it('renames, moves, resizes and rolls a group up (own fields only)', () => {
      const start = withDisplay()
      start.displays[0].groups = [group('g')]
      const { store } = hydrated(start)
      const api = store.getState()

      api.renameGroup(1, 'g', 'Work')
      api.moveGroup(1, 'g', { x: 100, y: 120 })
      api.resizeGroup(1, 'g', { x: 96, y: 120, width: 320, height: 240 })
      api.toggleRollUp(1, 'g')
      api.setGroupSort(1, 'g', 'name')
      api.setExcludeFromQuickHide(1, 'g', true)

      expect(store.getState().layout.displays[0].groups[0]).toMatchObject({
        title: 'Work',
        x: 96,
        y: 120,
        w: 320,
        h: 240,
        rolledUp: true,
        sort: 'name',
        excludeFromQuickHide: true,
        items: ['1:2']
      })
      api.toggleRollUp(1, 'g')
      expect(store.getState().layout.displays[0].groups[0].rolledUp).toBe(false)
    })

    it('applyAutoOrganize adds the groups and moves the loose items into them', () => {
      const { store } = hydrated(placed({ '1:1': { x: 0, y: 0 } }))
      store.getState().applyAutoOrganize(1, [group('apps', { items: ['1:1'] })])
      const display = store.getState().layout.displays[0]
      expect(display.loose).toEqual({})
      expect(display.groups.map((g) => [g.id, g.items])).toEqual([['apps', ['1:1']]])
    })

    it('arrangeLoose lays the loose icons out again in the given order', () => {
      const { store } = hydrated(placed({ a: { x: 300, y: 200 }, b: { x: 5, y: 5 } }))
      store.getState().arrangeLoose(1, ['a', 'b'], AREA, CELL)
      expect(store.getState().layout.displays[0].loose).toEqual({
        a: { x: 0, y: 0 },
        b: { x: 0, y: 100 }
      })
    })
  })

  describe('round 2 actions', () => {
    function hydrated(data: LayoutFile): {
      bridge: ReturnType<typeof installFakeBridge>
      store: ReturnType<typeof createLayoutStore>
    } {
      const bridge = installFakeBridge()
      const store = createLayoutStore()
      store.getState().receive({ revision: 1, data })
      return { bridge, store }
    }

    it('toggleRollUp with the work area: rolled down on top, growing upward; one save', async () => {
      const start = withDisplay()
      start.displays[0].groups = [
        group('low', { y: 900, h: 300, z: 1, rolledUp: true }),
        group('other', { z: 4 })
      ]
      const { bridge, store } = hydrated(start)

      store.getState().toggleRollUp(1, 'low', { x: 0, y: 0, width: 1920, height: 1032 })

      expect(store.getState().layout.displays[0].groups[0]).toMatchObject({
        rolledUp: false,
        y: 732,
        h: 300,
        z: 5
      })
      await drain()
      expect(bridge.storage.save).toHaveBeenCalledOnce()
    })

    it('reorderInGroup reorders a sorted group from the order shown and makes it manual', async () => {
      const start = withDisplay()
      start.displays[0].groups = [group('g', { sort: 'name', items: ['1:1', '1:2', '1:3'] })]
      const { bridge, store } = hydrated(start)

      store.getState().reorderInGroup(1, 'g', ['1:3'], '1:1', ['1:3', '1:2', '1:1'])

      expect(store.getState().layout.displays[0].groups[0]).toMatchObject({
        sort: 'manual',
        items: ['1:2', '1:3', '1:1']
      })
      await drain()
      expect(bridge.storage.save).toHaveBeenCalledOnce()
    })
  })

  describe('Phase 8 actions', () => {
    it('placeItems places on one display (off every other) and restorePlacements undoes it', async () => {
      const bridge = installFakeBridge()
      const store = createLayoutStore()
      const start: LayoutFile = {
        ...emptyLayout(),
        displays: [
          { ...newDisplayLayout(1, PRIMARY), groups: [group('g-1', { items: ['1:2', '1:3'] })] },
          { ...newDisplayLayout(2, SECONDARY), loose: { '1:9': { x: 0, y: 0 } } }
        ]
      }
      store.getState().receive({ revision: 1, data: start })
      const snapshot = [
        { id: '1:2', displayId: 1, at: { groupId: 'g-1', beforeId: '1:3' } },
        { id: '1:9', displayId: 2, at: { loose: { x: 0, y: 0 } } },
        { id: '5:5', displayId: null, at: null }
      ]

      store.getState().placeItems(1, ['1:9', '5:5', '1:2'], {
        loose: [
          { x: 96, y: 0 },
          { x: 96, y: 96 },
          { x: 0, y: 96 }
        ]
      })
      let [one, two] = store.getState().layout.displays
      expect(one.loose).toEqual({
        '1:9': { x: 96, y: 0 },
        '5:5': { x: 96, y: 96 },
        '1:2': { x: 0, y: 96 }
      })
      expect(one.groups[0].items).toEqual(['1:3'])
      expect(two.loose).toEqual({})

      store.getState().restorePlacements(snapshot)
      ;[one, two] = store.getState().layout.displays
      expect(one.loose).toEqual({})
      expect(one.groups[0].items).toEqual(['1:2', '1:3'])
      expect(two.loose).toEqual({ '1:9': { x: 0, y: 0 } })
      await drain()
      expect(bridge.storage.save.mock.calls.at(-1)?.[1].data).toEqual(store.getState().layout)
    })
  })
})
