import { describe, expect, it } from 'vitest'
import { createDisplayStore } from '../stores/display'
import { createUiStore } from '../stores/ui'
import { createFakeBridge } from '../test/fake-bridge'
import { connectInspector } from './inspector-sync'

describe('connectInspector (the tray’s Settings…)', () => {
  it('opens the inspector only in the window covering the named display', () => {
    const bridge = createFakeBridge()
    const display = createDisplayStore()
    const ui = createUiStore()
    display.getState().setDisplayId(7)
    const disconnect = connectInspector(bridge, { display, ui })

    bridge.emit('inspector:open', { displayId: 3 })
    expect(ui.getState().inspectorOpen).toBe(false)

    bridge.emit('inspector:open', { displayId: 7 })
    expect(ui.getState().inspectorOpen).toBe(true)

    ui.getState().setInspectorOpen(false)
    disconnect()
    bridge.emit('inspector:open', { displayId: 7 })
    expect(ui.getState().inspectorOpen).toBe(false)
    expect(bridge.listenerCount('inspector:open')).toBe(0)
  })
})
