import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { connectQuickHide } from '../../lib/quick-hide'
import { useUiStore } from '../../stores/ui'
import {
  desktopItem,
  makeGroup,
  PRIMARY_INFO,
  seedCanvas,
  type SeedOptions
} from '../../test/canvas-fixtures'
import { createFakeBridge, installFakeBridge, type FakeBridge } from '../../test/fake-bridge'
import { DesktopCanvas } from './DesktopCanvas'

const ITEMS = [desktopItem('1:1', 'Notes'), desktopItem('1:2', 'Plan')]
const GROUPS = [
  makeGroup('work', { title: 'Work', items: ['1:2'], x: 400, y: 40 }),
  makeGroup('pinned', { title: 'Pinned', x: 800, y: 40, excludeFromQuickHide: true })
]

function setup(
  seed: SeedOptions = {},
  bridge: FakeBridge = createFakeBridge()
): {
  bridge: FakeBridge
  user: ReturnType<typeof userEvent.setup>
} {
  installFakeBridge(bridge)
  seedCanvas({ items: ITEMS, groups: GROUPS, loose: { '1:1': { x: 0, y: 0 } }, ...seed })
  render(
    <main>
      <DesktopCanvas displayId={1} info={PRIMARY_INFO} />
    </main>
  )
  return { bridge, user: userEvent.setup() }
}

const surface = (): HTMLElement => document.querySelector('[data-canvas-surface]') as HTMLElement
const looseLayer = (): HTMLElement => document.querySelector('[data-loose-layer]') as HTMLElement
const group = (title: string): HTMLElement =>
  document.querySelector(`[aria-label="${title}"][data-group-id]`) as HTMLElement

describe('quick-hide', () => {
  it('double-clicking the empty desktop fades icons and groups out over 180 ms; excluded groups stay', async () => {
    const { user } = setup()
    await user.dblClick(surface())

    expect(useUiStore.getState().quickHidden).toBe(true)
    // The loose layer fades with its own utility; a group with .group-window (motion.css: opacity
    // 180 ms).
    expect(looseLayer()).toHaveClass('duration-[180ms]')
    expect(group('Work')).toHaveClass('group-window')
    for (const hidden of [looseLayer(), group('Work')]) {
      expect(hidden).toHaveClass('opacity-0')
      expect(hidden).toHaveAttribute('aria-hidden', 'true')
      expect(hidden).toHaveAttribute('inert')
    }
    expect(group('Pinned')).not.toHaveClass('opacity-0')
    expect(group('Pinned')).not.toHaveAttribute('inert')
    expect(screen.getByRole('region', { name: 'Pinned' })).toBeVisible()
    // Hidden things leave the accessibility tree; the excluded group is still there.
    expect(screen.queryByRole('option', { name: 'Notes' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Work' })).toBeNull()
  })

  it('a second double-click brings everything back', async () => {
    const { user } = setup()
    await user.dblClick(surface())
    await user.dblClick(surface())
    expect(useUiStore.getState().quickHidden).toBe(false)
    expect(looseLayer()).not.toHaveClass('opacity-0')
    expect(screen.getByRole('option', { name: 'Notes' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Work' })).toBeInTheDocument()
  })

  it('tells main, so every display hides together', async () => {
    const { bridge, user } = setup()
    await user.dblClick(surface())
    await user.dblClick(surface())
    expect(bridge.quickHide.set.mock.calls).toEqual([[true], [false]])
  })

  it('follows another display hiding or showing (quickHide:changed)', () => {
    const { bridge } = setup()
    const disconnect = connectQuickHide(bridge)
    act(() => bridge.emit('quickHide:changed', { hidden: true }))
    expect(looseLayer()).toHaveClass('opacity-0')
    act(() => bridge.emit('quickHide:changed', { hidden: false }))
    expect(looseLayer()).not.toHaveClass('opacity-0')
    disconnect()
    expect(bridge.listenerCount('quickHide:changed')).toBe(0)
  })

  it('a window that loads while the desktop is hidden starts hidden (quickHide:get)', async () => {
    const bridge = createFakeBridge()
    bridge.quickHide.get.mockResolvedValue(true)
    setup({}, bridge)
    connectQuickHide(bridge)
    await waitFor(() => expect(useUiStore.getState().quickHidden).toBe(true))
  })

  it('is never persisted: hiding saves nothing', async () => {
    const { bridge, user } = setup()
    bridge.storage.save.mockClear()
    await user.dblClick(surface())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(bridge.storage.save).not.toHaveBeenCalled()
  })

  it('double-clicking an icon or a group opens or rolls it instead of hiding', async () => {
    const { bridge, user } = setup()
    await user.dblClick(screen.getByRole('option', { name: 'Notes' }))
    expect(bridge.desktop.open).toHaveBeenCalledWith('1:1')
    await user.dblClick(screen.getByRole('option', { name: 'Plan' }))
    expect(useUiStore.getState().quickHidden).toBe(false)
    expect(bridge.quickHide.set).not.toHaveBeenCalled()
  })

  it('does nothing when "quick-hide on double-click" is off', async () => {
    const { bridge, user } = setup({ settings: { quickHideOnDoubleClick: false } })
    await user.dblClick(surface())
    expect(useUiStore.getState().quickHidden).toBe(false)
    expect(bridge.quickHide.set).not.toHaveBeenCalled()
  })

  it('double-clicking where a hidden group was reaches the desktop and shows everything again', async () => {
    const { user } = setup()
    await user.dblClick(surface())
    expect(group('Work')).toHaveClass('pointer-events-none')
    await user.dblClick(surface())
    expect(useUiStore.getState().quickHidden).toBe(false)
  })
})
