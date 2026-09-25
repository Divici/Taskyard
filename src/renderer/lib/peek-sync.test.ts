import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDisplayStore } from '../stores/display'
import { useUiStore } from '../stores/ui'
import { installFakeBridge, type FakeBridge } from '../test/fake-bridge'
import { ACTIVITY_THROTTLE_MS, connectPeek } from './peek-sync'

let bridge: FakeBridge
let disconnect: () => void

/** A desktop page: the empty canvas, a group with an icon, a kept widget, a menu and inputs. */
function page(): void {
  document.body.innerHTML = `
    <main>
      <div data-canvas-surface id="surface"></div>
      <section data-group-id="g" id="group"><div role="option" data-item-id="1:1" id="icon"></div></section>
      <div data-item-id="1:2" id="loose"></div>
      <aside data-peek-keep id="widget"><input id="text" type="text" /><input id="check" type="checkbox" /></aside>
      <div role="menu" id="menu"><div role="menuitem" id="menuitem"></div></div>
      <textarea id="notes"></textarea>
    </main>`
}

const el = (id: string): HTMLElement => document.getElementById(id)!

function press(id: string, button = 0): void {
  el(id).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button }))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  page()
  // Installed: quick-hide (shown again by a Peek) goes through window.taskyard.
  bridge = installFakeBridge()
})

afterEach(() => {
  disconnect?.()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function connect(): void {
  disconnect = connectPeek(bridge, document)
}

function startPeek(): void {
  bridge.emit('peek:changed', { peeking: true })
}

describe('peek state in a window', () => {
  it('pulls the state when the window loads during a Peek (peek:get)', async () => {
    bridge.peek.get.mockResolvedValue({ peeking: true })
    connect()
    await vi.waitFor(() => expect(useDisplayStore.getState().peeking).toBe(true))
  })

  it('a peek:changed that arrives first wins over the late answer', async () => {
    let answer: (state: { peeking: boolean }) => void = () => {}
    bridge.peek.get.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    connect()
    startPeek()
    answer({ peeking: false })
    await Promise.resolve()
    await Promise.resolve()
    expect(useDisplayStore.getState().peeking).toBe(true)
  })

  it('a Peek shows the desktop again when it was quick-hidden', () => {
    connect()
    useUiStore.getState().setQuickHidden(true)
    startPeek()
    expect(useUiStore.getState().quickHidden).toBe(false)
    expect(bridge.quickHide.set).toHaveBeenCalledWith(false)
  })
})

describe('click outside a group ends the Peek', () => {
  it('a left click on the empty desktop tells main (which unpeeks)', () => {
    connect()
    startPeek()
    press('surface')
    expect(bridge.peek.clickOutside).toHaveBeenCalledOnce()
    expect(bridge.peek.activity).not.toHaveBeenCalled()
  })

  it('clicks on a group, an icon, a kept widget or a menu are activity, not outside', () => {
    connect()
    startPeek()
    for (const id of ['group', 'icon', 'loose', 'widget', 'menuitem']) {
      press(id)
      vi.advanceTimersByTime(ACTIVITY_THROTTLE_MS)
    }
    expect(bridge.peek.clickOutside).not.toHaveBeenCalled()
    expect(bridge.peek.activity).toHaveBeenCalledTimes(5)
  })

  it('a right click on the desktop is activity (its menu opens; the Peek stays)', () => {
    connect()
    startPeek()
    press('surface', 2)
    expect(bridge.peek.clickOutside).not.toHaveBeenCalled()
    expect(bridge.peek.activity).toHaveBeenCalledOnce()
  })

  it('sends nothing while not peeking', () => {
    connect()
    press('surface')
    press('group')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    el('text').focus()
    expect(bridge.peek.clickOutside).not.toHaveBeenCalled()
    expect(bridge.peek.activity).not.toHaveBeenCalled()
    expect(bridge.peek.inputFocus).not.toHaveBeenCalled()
  })
})

describe('the idle timer', () => {
  it(`keys, wheel and pointer presses restart it, at most once per ${ACTIVITY_THROTTLE_MS} ms`, () => {
    connect()
    startPeek()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    document.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    press('group')
    expect(bridge.peek.activity).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(ACTIVITY_THROTTLE_MS)
    document.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    expect(bridge.peek.activity).toHaveBeenCalledTimes(2)
  })

  it('is paused while a text input has focus (text fields and text areas, not checkboxes)', () => {
    connect()
    startPeek()
    // Every Peek starts with this window's current state (nothing focused).
    expect(bridge.peek.inputFocus.mock.calls).toEqual([[false]])
    el('text').focus()
    expect(bridge.peek.inputFocus.mock.calls).toEqual([[false], [true]])
    el('notes').focus()
    // Moving from one text field to another keeps it paused: no chatter.
    expect(bridge.peek.inputFocus.mock.calls).toEqual([[false], [true]])
    el('check').focus()
    expect(bridge.peek.inputFocus.mock.calls).toEqual([[false], [true], [false]])
    el('check').blur()
    expect(bridge.peek.inputFocus.mock.calls).toEqual([[false], [true], [false]])
  })

  it('reports its focus state whenever a Peek starts, even if unchanged (never deduped)', () => {
    connect()
    el('text').focus()
    expect(bridge.peek.inputFocus).not.toHaveBeenCalled()
    startPeek()
    expect(bridge.peek.inputFocus.mock.calls).toEqual([[true]])
    bridge.emit('peek:changed', { peeking: false })
    startPeek()
    expect(bridge.peek.inputFocus.mock.calls).toEqual([[true], [true]])
  })

  it('a renderer that loads during a Peek (peek:get) reports its focus state', async () => {
    bridge.peek.get.mockResolvedValue({ peeking: true })
    connect()
    await vi.waitFor(() => expect(bridge.peek.inputFocus.mock.calls).toEqual([[false]]))
  })

  it('disconnect removes every listener', () => {
    connect()
    disconnect()
    startPeek()
    press('surface')
    expect(bridge.peek.clickOutside).not.toHaveBeenCalled()
    expect(bridge.listenerCount('peek:changed')).toBe(0)
    expect(bridge.listenerCount('peek:shortcut')).toBe(0)
  })
})

describe('the Peek shortcut status', () => {
  it('a shortcut main could not register at start becomes an error toast', async () => {
    bridge.peek.shortcutStatus.mockResolvedValue({
      accelerator: 'Ctrl+Alt+Space',
      active: null,
      error: 'in-use'
    })
    connect()
    await waitFor(() =>
      expect(useUiStore.getState().toasts).toEqual([
        expect.objectContaining({
          id: 'peek-shortcut',
          tone: 'error',
          message: 'Ctrl+Alt+Space is already used by another app, so Peek has no shortcut.',
          durationMs: null
        })
      ])
    )
  })

  it('a rebind that fails says which shortcut still works; a good one clears the toast', () => {
    connect()
    bridge.emit('peek:shortcut', {
      accelerator: 'Ctrl+Alt+Spacebar',
      active: 'Ctrl+Alt+Space',
      error: 'invalid'
    })
    expect(useUiStore.getState().toasts[0]).toMatchObject({
      message: '“Ctrl+Alt+Spacebar” isn’t a valid shortcut. Peek still uses Ctrl+Alt+Space.'
    })
    bridge.emit('peek:shortcut', {
      accelerator: 'Ctrl+Shift+P',
      active: 'Ctrl+Shift+P',
      error: null
    })
    expect(useUiStore.getState().toasts).toEqual([])
  })
})
