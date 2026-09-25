import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { DisplayInfo } from '@shared/ipc'
import type { SettingsFile, ToolsState } from '@shared/schema'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import { PRIMARY_INFO, seedCanvas } from '../../test/canvas-fixtures'
import { installFakeBridge, type FakeBridge } from '../../test/fake-bridge'
import { DesktopCanvas } from '../canvas/DesktopCanvas'

function renderCanvas(
  tools: Partial<ToolsState> = {},
  settings: Partial<SettingsFile> = {},
  info: DisplayInfo = PRIMARY_INFO
): {
  bridge: FakeBridge
  user: ReturnType<typeof userEvent.setup>
  rerender(info: DisplayInfo): void
} {
  const bridge = installFakeBridge()
  seedCanvas({ settings, display: info })
  act(() =>
    useLayoutStore
      .getState()
      .updateTools(info.id, (current) => ({ ...current, x: 2000, y: 24, ...tools }))
  )
  const tree = (display: DisplayInfo): React.JSX.Element => (
    <main>
      <DesktopCanvas displayId={display.id} info={display} />
    </main>
  )
  const { rerender } = render(tree(info))
  return { bridge, user: userEvent.setup(), rerender: (next) => rerender(tree(next)) }
}

const widget = (): HTMLElement | null => document.querySelector('[data-tools-widget]')
const tools = (): ToolsState => useLayoutStore.getState().layout.displays[0].tools

async function canvasMenuItem(name: string): Promise<HTMLElement> {
  fireEvent.contextMenu(document.querySelector('[data-canvas-surface]') as HTMLElement, {
    clientX: 700,
    clientY: 500
  })
  return screen.findByRole('menuitem', { name })
}

describe('tools widget on the desktop', () => {
  it('shows on a display whose layout has it visible', () => {
    renderCanvas({ visible: true })

    expect(screen.getByRole('region', { name: 'Tools' })).toBeVisible()
  })

  it('does not show on a display whose layout hides it', () => {
    renderCanvas({ visible: false })

    expect(widget()).toBeNull()
  })

  it('toolsEnabled off hides it everywhere and saves nothing (tasks and timer stay on disk)', () => {
    const { bridge } = renderCanvas({ visible: true }, { toolsEnabled: false })

    expect(widget()).toBeNull()
    expect(bridge.storage.save).not.toHaveBeenCalledWith('tasks', expect.anything())
  })

  it('the desktop menu hides and shows it on this display', async () => {
    const { user } = renderCanvas({ visible: true })

    await user.click(await canvasMenuItem('Hide tools widget'))
    expect(tools().visible).toBe(false)
    expect(widget()).toBeNull()

    await user.click(await canvasMenuItem('Show tools widget'))
    expect(tools().visible).toBe(true)
    expect(widget()).not.toBeNull()
  })

  it('"Show tools widget" turns the tools back on when Settings had them off', async () => {
    const { user } = renderCanvas({ visible: true }, { toolsEnabled: false })

    await user.click(await canvasMenuItem('Show tools widget'))

    expect(useSettingsStore.getState().settings.toolsEnabled).toBe(true)
    expect(widget()).not.toBeNull()
  })

  it('quick-hide hides it with the groups', () => {
    renderCanvas({ visible: true })

    act(() => useUiStore.getState().setQuickHidden(true))

    expect(widget()).toHaveAttribute('inert')
  })

  it('is pulled back inside the work area when the work area shrinks', () => {
    const { rerender } = renderCanvas({ visible: true, x: 2200, y: 24, w: 320, h: 400 })

    act(() => rerender({ ...PRIMARY_INFO, workArea: { x: 0, y: 0, width: 1920, height: 1032 } }))

    expect(tools()).toMatchObject({ x: 1600, y: 24, w: 320, h: 400 })
  })
})
