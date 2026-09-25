import { describe, expect, it, vi } from 'vitest'
import { emptyLayout } from '@shared/defaults'
import type { DisplayInfo } from '@shared/ipc'
import type { LayoutFile } from '@shared/schema'
import { FakeMain, tick } from '@shared/test/fake-main'
import { createDisplayStore } from '../stores/display'
import { createLayoutStore } from '../stores/layout'
import { createFakeBridge, type FakeBridge } from '../test/fake-bridge'
import { connectDisplay, type DisplaySyncTargets } from './display-sync'

const PRIMARY: DisplayInfo = {
  id: 2450156880,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1392 },
  scaleFactor: 1
}
const SECONDARY: DisplayInfo = {
  id: 1529295726,
  bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
  workArea: { x: 2560, y: 0, width: 1920, height: 1032 },
  scaleFactor: 1.5
}
const DISPLAYS = [PRIMARY, SECONDARY]

const search = (id: number): string => `?displayId=${id}`

/** A bridge whose display.get answers like main's display handler. */
function bridge(): FakeBridge {
  const api = createFakeBridge()
  api.display.get.mockImplementation(async (id) => DISPLAYS.find((d) => d.id === id) ?? null)
  return api
}

interface Spied {
  targets: DisplaySyncTargets
  display: ReturnType<typeof createDisplayStore>
  ensureDisplay: ReturnType<typeof vi.fn>
}

/** A display store plus a layout whose ensureDisplay is only recorded. */
function spied(): Spied {
  const display = createDisplayStore()
  const ensureDisplay = vi.fn()
  return {
    display,
    ensureDisplay,
    targets: { display, layout: { getState: () => ({ ensureDisplay }) } }
  }
}

async function flush(): Promise<void> {
  for (let n = 0; n < 3; n++) await tick()
}

describe('connectDisplay', () => {
  it('fetches its own display from main by the id in its URL and keeps it in the display store', async () => {
    const api = bridge()
    const { display, targets } = spied()

    connectDisplay(api, search(SECONDARY.id), targets)
    await flush()

    expect(api.display.get).toHaveBeenCalledExactlyOnceWith(SECONDARY.id)
    expect(display.getState()).toMatchObject({
      displayId: SECONDARY.id,
      info: SECONDARY,
      problem: null
    })
  })

  it('registers the display in the layout with the bounds main sent', async () => {
    const { ensureDisplay, targets } = spied()

    connectDisplay(bridge(), search(SECONDARY.id), targets)
    await flush()

    expect(ensureDisplay).toHaveBeenCalledExactlyOnceWith({
      id: SECONDARY.id,
      bounds: SECONDARY.bounds,
      tools: { visible: false, x: 1576, y: 24 }
    })
  })

  it('a new layout entry shows the tools widget on the primary display only, top-right of its work area', async () => {
    const { ensureDisplay, targets } = spied()

    connectDisplay(bridge(), search(PRIMARY.id), targets)
    await flush()

    expect(ensureDisplay).toHaveBeenCalledExactlyOnceWith({
      id: PRIMARY.id,
      bounds: PRIMARY.bounds,
      tools: { visible: true, x: 2216, y: 24 }
    })
  })

  it('follows display:changed for its own display: new info, and the layout entry refreshed', async () => {
    const api = bridge()
    const { display, ensureDisplay, targets } = spied()
    connectDisplay(api, search(SECONDARY.id), targets)
    await flush()
    const rescaled = { ...SECONDARY, scaleFactor: 2, bounds: { ...SECONDARY.bounds, width: 2560 } }

    api.emit('display:changed', rescaled)

    expect(display.getState().info).toEqual(rescaled)
    expect(ensureDisplay).toHaveBeenLastCalledWith({
      id: SECONDARY.id,
      bounds: rescaled.bounds,
      tools: { visible: false, x: 1576, y: 24 }
    })
  })

  it('ignores a display:changed about another display', async () => {
    const api = bridge()
    const { display, ensureDisplay, targets } = spied()
    connectDisplay(api, search(SECONDARY.id), targets)
    await flush()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    api.emit('display:changed', PRIMARY)

    expect(display.getState().info).toEqual(SECONDARY)
    expect(ensureDisplay).toHaveBeenCalledOnce()
    expect(console.warn).toHaveBeenCalledOnce()
  })

  it('follows peek:changed', async () => {
    const api = bridge()
    const { display, targets } = spied()
    connectDisplay(api, search(PRIMARY.id), targets)

    api.emit('peek:changed', { peeking: true })
    expect(display.getState().peeking).toBe(true)
    api.emit('peek:changed', { peeking: false })
    expect(display.getState().peeking).toBe(false)
  })

  it('lets a display:changed that arrives while the fetch is in flight win over the older answer', async () => {
    const api = bridge()
    let answer!: (info: DisplayInfo) => void
    api.display.get.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const { display, ensureDisplay, targets } = spied()
    connectDisplay(api, search(SECONDARY.id), targets)
    const moved = { ...SECONDARY, bounds: { ...SECONDARY.bounds, x: -1920 } }

    api.emit('display:changed', moved)
    answer(SECONDARY)
    await flush()

    expect(display.getState().info).toEqual(moved)
    expect(ensureDisplay).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: SECONDARY.id, bounds: moved.bounds })
    )
  })

  it('never registers the display in reaction to layout changes (its own save is echoed back)', async () => {
    const main = new FakeMain<LayoutFile>(emptyLayout())
    const window = main.connect()
    const layout = createLayoutStore({ transport: window.transport })
    window.receive = (snapshot) => layout.getState().receive(snapshot)
    layout.getState().receive(main.snapshot())
    const ensureDisplay = vi.spyOn(layout.getState(), 'ensureDisplay')
    const display = createDisplayStore()

    connectDisplay(bridge(), search(PRIMARY.id), { display, layout })
    await flush()
    await main.settle()
    const savesAfterRegistering = main.saves
    // Another window's save arrives, and so does a newer copy of this one's.
    main.data = { ...main.data, paths: { '1:2': 'C:\\Users\\me\\Desktop\\a.txt' } }
    main.revision += 1
    layout.getState().receive(main.snapshot())
    await main.settle()

    expect(ensureDisplay).toHaveBeenCalledOnce()
    expect(main.saves).toBe(savesAfterRegistering)
    expect(main.data.displays.map((d) => d.displayId)).toEqual([PRIMARY.id])
  })

  it('reports a URL without a display id and asks main for nothing', () => {
    const api = bridge()
    const { display, ensureDisplay, targets } = spied()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    connectDisplay(api, '', targets)

    expect(api.display.get).not.toHaveBeenCalled()
    expect(display.getState()).toMatchObject({ displayId: null, problem: 'no-display-id' })
    expect(ensureDisplay).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledOnce()
  })

  it('reports a display main does not know (display:get answers null)', async () => {
    const api = bridge()
    api.display.get.mockResolvedValue(null)
    const { display, ensureDisplay, targets } = spied()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    connectDisplay(api, search(77), targets)
    await flush()

    expect(display.getState()).toMatchObject({
      displayId: 77,
      info: null,
      problem: 'unknown-display'
    })
    expect(ensureDisplay).not.toHaveBeenCalled()
  })

  it('reports a failed fetch, and still takes the display from a later display:changed', async () => {
    const api = bridge()
    api.display.get.mockRejectedValue(new Error('untrusted sender for display:get'))
    const { display, ensureDisplay, targets } = spied()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    connectDisplay(api, search(PRIMARY.id), targets)
    await flush()
    expect(display.getState().problem).toBe('fetch-failed')

    api.emit('display:changed', PRIMARY)
    expect(display.getState()).toMatchObject({ info: PRIMARY, problem: null })
    expect(ensureDisplay).toHaveBeenCalledOnce()
  })

  it('stops listening, and ignores a late answer, once disconnected', async () => {
    const api = bridge()
    const { display, ensureDisplay, targets } = spied()

    const disconnect = connectDisplay(api, search(PRIMARY.id), targets)
    disconnect()
    await flush()

    expect(api.listenerCount('display:changed')).toBe(0)
    expect(api.listenerCount('peek:changed')).toBe(0)
    expect(display.getState().info).toBeNull()
    expect(ensureDisplay).not.toHaveBeenCalled()
  })

  // useBridgeSync connects the display before it hydrates, and display:get is invoked before
  // storage:load, so in the app the display usually arrives first: ensureDisplay is queued on the
  // unhydrated layout and replayed on the loaded file. Both timings are covered.
  it.each([
    ['display first (the app: display:get before storage:load)', 'fifo', 'display-first'],
    ['display first (the app: display:get before storage:load)', 'lifo', 'display-first'],
    ['layout first', 'fifo', 'layout-first'],
    ['layout first', 'lifo', 'layout-first']
  ] as const)(
    'two windows registering their displays at once leave one entry per display: %s, %s',
    async (_title, order, timing) => {
      const main = new FakeMain<LayoutFile>(emptyLayout())
      const windows = DISPLAYS.map((info) => {
        const window = main.connect()
        const layout = createLayoutStore({ transport: window.transport })
        window.receive = (snapshot) => layout.getState().receive(snapshot)
        return { info, layout }
      })
      const hydrateAll = (): void => {
        for (const { layout } of windows) layout.getState().receive(main.snapshot())
      }

      if (timing === 'layout-first') hydrateAll()
      for (const { info, layout } of windows) {
        connectDisplay(bridge(), search(info.id), { display: createDisplayStore(), layout })
      }
      await flush()
      if (timing === 'display-first') {
        // Registered before the layout arrived: queued, never saved on top of the defaults.
        expect(main.saves).toBe(0)
        for (const { layout } of windows) expect(layout.getState().hydrated).toBe(false)
        hydrateAll()
      }
      await main.settle(order)
      const settled = { revision: main.revision, saves: main.saves }
      await main.settle(order)

      expect(
        main.data.displays
          .map((d) => ({ id: d.displayId, bounds: d.bounds }))
          .sort((a, b) => a.id - b.id)
      ).toEqual(DISPLAYS.map((d) => ({ id: d.id, bounds: d.bounds })).sort((a, b) => a.id - b.id))
      // Revision 1 is the loaded file; one accepted save per window.
      expect(main.revision).toBe(1 + DISPLAYS.length)
      for (const { layout } of windows) expect(layout.getState().layout).toEqual(main.data)
      // Settled for good: no window saves again in reaction to the other's (no ping-pong).
      expect({ revision: main.revision, saves: main.saves }).toEqual(settled)
    }
  )
})
