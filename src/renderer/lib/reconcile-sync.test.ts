import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, emptyLayout } from '@shared/defaults'
import type { DisplayInfo } from '@shared/ipc'
import { createDisplayStore } from '../stores/display'
import { createItemsStore } from '../stores/items'
import { createLayoutStore } from '../stores/layout'
import { createSettingsStore } from '../stores/settings'
import { desktopItem, PRIMARY_INFO } from '../test/canvas-fixtures'
import { installFakeBridge } from '../test/fake-bridge'
import { connectReconcile, isPrimaryDisplay } from './reconcile-sync'

const SECONDARY_INFO: DisplayInfo = {
  id: 2,
  bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
  workArea: { x: 2560, y: 0, width: 1920, height: 1032 },
  scaleFactor: 1
}
const NOW = 1_760_000_000_000

function stores(): {
  items: ReturnType<typeof createItemsStore>
  layout: ReturnType<typeof createLayoutStore>
  display: ReturnType<typeof createDisplayStore>
  settings: ReturnType<typeof createSettingsStore>
} {
  const settings = createSettingsStore()
  settings.getState().receive({ revision: 1, data: defaultSettings() })
  return {
    items: createItemsStore(),
    layout: createLayoutStore(),
    display: createDisplayStore(),
    settings
  }
}

/** What connectDisplay does when main describes the window's display. */
function showDisplay(s: ReturnType<typeof stores>, info: DisplayInfo): void {
  s.display.getState().receiveInfo(info)
  s.layout.getState().ensureDisplay({ id: info.id, bounds: info.bounds })
}

describe('isPrimaryDisplay', () => {
  it('is the display at the origin of the virtual screen (Windows puts the primary there)', () => {
    expect(isPrimaryDisplay(PRIMARY_INFO)).toBe(true)
    expect(isPrimaryDisplay(SECONDARY_INFO)).toBe(false)
  })
})

describe('connectReconcile', () => {
  it('in the primary window: places the desktop once items, layout and display are all known', () => {
    installFakeBridge()
    const s = stores()
    const disconnect = connectReconcile(s, () => NOW)

    s.items.getState().hydrate([desktopItem('1:2', 'b'), desktopItem('1:1', 'a')])
    expect(s.layout.getState().layout.displays).toEqual([])
    s.layout.getState().receive({ revision: 1, data: emptyLayout() })
    showDisplay(s, PRIMARY_INFO)

    const layout = s.layout.getState().layout
    expect(layout.displays[0].loose).toEqual({ '1:1': { x: 0, y: 0 }, '1:2': { x: 0, y: 96 } })
    expect(Object.keys(layout.paths).sort()).toEqual(['1:1', '1:2'])
    disconnect()
  })

  it('follows desktop changes: new files are placed, removed ones stamped', () => {
    installFakeBridge()
    const s = stores()
    const disconnect = connectReconcile(s, () => NOW)
    s.layout.getState().receive({ revision: 1, data: emptyLayout() })
    showDisplay(s, PRIMARY_INFO)
    s.items.getState().hydrate([desktopItem('1:1', 'a')])

    s.items
      .getState()
      .applyChange({ added: [desktopItem('1:3', 'c')], removed: ['1:1'], changed: [] })

    const layout = s.layout.getState().layout
    expect(layout.displays[0].loose['1:3']).toEqual({ x: 0, y: 96 })
    expect(layout.lastSeen).toEqual({ '1:1': NOW })
    disconnect()
  })

  it('never writes from a secondary display’s window (single writer)', async () => {
    const bridge = installFakeBridge()
    const s = stores()
    const disconnect = connectReconcile(s, () => NOW)
    s.layout.getState().receive({ revision: 1, data: emptyLayout() })
    s.display.getState().receiveInfo(SECONDARY_INFO)
    s.items.getState().hydrate([desktopItem('1:1', 'a')])
    s.items.getState().applyChange({ added: [], removed: ['1:1'], changed: [] })

    await vi.waitFor(() => expect(s.layout.getState().layout).toEqual(emptyLayout()))
    expect(bridge.storage.save).not.toHaveBeenCalled()
    disconnect()
  })

  it('stops after disconnect', () => {
    installFakeBridge()
    const s = stores()
    connectReconcile(s, () => NOW)()
    s.layout.getState().receive({ revision: 1, data: emptyLayout() })
    showDisplay(s, PRIMARY_INFO)
    s.items.getState().hydrate([desktopItem('1:1', 'a')])
    expect(s.layout.getState().layout.displays[0].loose).toEqual({})
  })
})
