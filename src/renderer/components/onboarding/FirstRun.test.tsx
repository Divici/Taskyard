import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import type { DisplayInfo } from '@shared/ipc'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import { desktopItem, PRIMARY_INFO, seedCanvas } from '../../test/canvas-fixtures'
import { installFakeBridge } from '../../test/fake-bridge'
import { DesktopCanvas } from '../canvas/DesktopCanvas'
import { FirstRun } from './FirstRun'

const AREA = { x: 0, y: 0, width: 2560, height: 1392 }
const SECONDARY: DisplayInfo = {
  id: 2,
  bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
  workArea: { x: 2560, y: 0, width: 1920, height: 1032 },
  scaleFactor: 1
}

const ITEMS = [
  desktopItem('1:1', 'Notes'),
  desktopItem('1:2', 'Tool', { kind: 'app', ext: '.exe' }),
  desktopItem('1:3', 'Docs', { kind: 'folder' })
]
const LOOSE = { '1:1': { x: 0, y: 0 }, '1:2': { x: 0, y: 96 }, '1:3': { x: 0, y: 192 } }

function renderFirstRun(): ReturnType<typeof render> & {
  card: HTMLElement
  user: ReturnType<typeof userEvent.setup>
} {
  installFakeBridge()
  seedCanvas({ items: ITEMS, loose: LOOSE, settings: { firstRunDone: false } })
  const view = render(<FirstRun displayId={PRIMARY_INFO.id} area={AREA} />)
  const card = screen.getByRole('dialog', { name: 'Welcome to Taskyard' })
  return { ...view, card, user: userEvent.setup() }
}

describe('FirstRun', () => {
  it('welcomes the user, names the Peek shortcut and offers Auto-organize as a choice', async () => {
    const { card, container } = renderFirstRun()

    expect(card).toHaveClass('glass')
    expect(card).toHaveAttribute('data-peek-keep')
    expect(within(card).getByText(/Ctrl\+Alt\+Space/)).toBeVisible()
    expect(within(card).getByRole('button', { name: 'Organize 3 icons by type' })).toBeVisible()
    expect(within(card).getByRole('button', { name: 'Keep my desktop as it is' })).toBeVisible()
    expect(within(card).getByRole('switch', { name: 'Start with Windows' })).toBeChecked()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('Auto-organize groups the loose icons by type and finishes the first run', async () => {
    const { card, user } = renderFirstRun()

    await user.click(within(card).getByRole('button', { name: 'Organize 3 icons by type' }))

    expect(useLayoutStore.getState().layout.displays[0].groups.map((g) => g.title)).toEqual([
      'Apps',
      'Files',
      'Folders'
    ])
    expect(useSettingsStore.getState().settings.firstRunDone).toBe(true)
  })

  it('keeping the desktop as it is changes nothing but finishes the first run', async () => {
    const { card, user } = renderFirstRun()

    await user.click(within(card).getByRole('button', { name: 'Keep my desktop as it is' }))

    expect(useLayoutStore.getState().layout.displays[0].groups).toEqual([])
    expect(useSettingsStore.getState().settings.firstRunDone).toBe(true)
  })

  it('Start with Windows can be turned off right there', async () => {
    const { card, user } = renderFirstRun()
    await user.click(within(card).getByRole('switch', { name: 'Start with Windows' }))
    expect(useSettingsStore.getState().settings.autostart).toBe(false)
  })

  it('with no icons yet, it only offers to get started', async () => {
    installFakeBridge()
    seedCanvas({ settings: { firstRunDone: false } })
    render(<FirstRun displayId={PRIMARY_INFO.id} area={AREA} />)
    const card = screen.getByRole('dialog', { name: 'Welcome to Taskyard' })
    expect(within(card).queryByRole('button', { name: /Organize/ })).toBeNull()
    expect(within(card).getByRole('button', { name: 'Get started' })).toBeVisible()
  })
})

describe('FirstRun on the desktop canvas', () => {
  it('shows once on the primary display instead of the empty-desktop hint, never again after', async () => {
    installFakeBridge()
    seedCanvas({ items: ITEMS, loose: LOOSE, settings: { firstRunDone: false } })
    const { rerender } = render(<DesktopCanvas displayId={PRIMARY_INFO.id} info={PRIMARY_INFO} />)

    expect(screen.getByRole('dialog', { name: 'Welcome to Taskyard' })).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Tidy up your desktop' })).toBeNull()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Keep my desktop as it is' }))
    rerender(<DesktopCanvas displayId={PRIMARY_INFO.id} info={PRIMARY_INFO} />)
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Welcome to Taskyard' })).toBeNull()
    )
    expect(screen.getByRole('region', { name: 'Tidy up your desktop' })).toBeVisible()
  })

  it('never shows on a secondary display', () => {
    installFakeBridge()
    seedCanvas({ display: SECONDARY, settings: { firstRunDone: false } })
    render(<DesktopCanvas displayId={SECONDARY.id} info={SECONDARY} />)
    expect(screen.queryByRole('dialog', { name: 'Welcome to Taskyard' })).toBeNull()
  })

  it('the canvas opens the inspector when asked (menu, tray)', async () => {
    installFakeBridge()
    seedCanvas()
    render(<DesktopCanvas displayId={PRIMARY_INFO.id} info={PRIMARY_INFO} />)
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
    act(() => useUiStore.getState().setInspectorOpen(true))
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeVisible()
  })
})
