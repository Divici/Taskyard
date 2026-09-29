import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { defaultStopwatch, defaultTimer, emptyTasks } from '@shared/defaults'
import type { StopwatchState, TimerState, ToolsState } from '@shared/schema'
import { PEEK_KEEP_SELECTOR } from '../../lib/peek-sync'
import { useLayoutStore } from '../../stores/layout'
import { useTasksStore } from '../../stores/tasks'
import { useUiStore } from '../../stores/ui'
import { seedCanvas } from '../../test/canvas-fixtures'
import { installFakeBridge } from '../../test/fake-bridge'
import { ToolsWidget } from './ToolsWidget'

const AREA = { x: 0, y: 0, width: 2560, height: 1392 }
const T0 = Date.UTC(2026, 8, 25, 9, 0, 0)

afterEach(() => {
  vi.useRealTimers()
})

function currentTools(): ToolsState {
  return useLayoutStore.getState().layout.displays[0].tools
}

function renderWidget(
  tools: Partial<ToolsState> = {},
  timer: Partial<TimerState> = {},
  hidden = false,
  stopwatch: Partial<StopwatchState> = {}
): { region: HTMLElement; user: ReturnType<typeof userEvent.setup>; container: HTMLElement } {
  installFakeBridge()
  seedCanvas()
  act(() => {
    useLayoutStore
      .getState()
      .updateTools(1, (current) => ({ ...current, x: 200, y: 120, w: 320, h: 400, ...tools }))
    useTasksStore.getState().receive({
      revision: 1,
      data: {
        ...emptyTasks(),
        timer: { ...defaultTimer(), ...timer },
        stopwatch: { ...defaultStopwatch(), ...stopwatch }
      }
    })
  })
  const { container } = render(
    <main>
      <ToolsWidget displayId={1} area={AREA} zIndex={5} hidden={hidden} />
    </main>
  )
  const user = vi.isFakeTimers()
    ? userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    : userEvent.setup()
  // Quick-hidden, it is aria-hidden (so it has no accessible name to find it by).
  const region = hidden
    ? (container.querySelector('[data-tools-widget]') as HTMLElement)
    : screen.getByRole('region', { name: 'Tools' })
  return { region, user, container }
}

describe('ToolsWidget', () => {
  it('is a glass region at its rect whose header names the active tool', async () => {
    const { region, container } = renderWidget()

    expect(region).toHaveClass('glass')
    expect(region).toHaveStyle({ left: '200px', top: '120px', width: '320px', height: '400px' })
    expect(within(region).getByRole('heading', { name: 'Tasks' })).toBeVisible()
    expect(within(region).getByRole('tabpanel', { name: 'Tasks' })).toBeVisible()
    expect(within(region).getByRole('textbox', { name: 'Add a task' })).toBeVisible()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('the tabs switch tools, and the active tool is saved per display', async () => {
    const { region, user } = renderWidget()

    await user.click(within(region).getByRole('tab', { name: 'Timer' }))

    expect(within(region).getByRole('heading', { name: 'Timer' })).toBeVisible()
    expect(within(region).getByRole('tabpanel', { name: 'Timer' })).toBeVisible()
    expect(within(region).getByRole('timer', { name: 'Time left' })).toHaveTextContent('25:00')
    expect(currentTools().activeTool).toBe('timer')

    await user.click(within(region).getByRole('tab', { name: 'Tasks' }))
    expect(within(region).getByRole('heading', { name: 'Tasks' })).toBeVisible()

    await user.click(within(region).getByRole('tab', { name: 'Stopwatch' }))
    expect(within(region).getByRole('heading', { name: 'Stopwatch' })).toBeVisible()
    expect(within(region).getByRole('tabpanel', { name: 'Stopwatch' })).toBeVisible()
    expect(within(region).getByRole('timer', { name: 'Elapsed time' })).toHaveTextContent(
      '0:00:00.0'
    )
    expect(currentTools().activeTool).toBe('stopwatch')
  })

  it('round 2: the tabs sit at the top of the widget, centred, with the tool under them', () => {
    const { region } = renderWidget()

    const tablist = within(region).getByRole('tablist', { name: 'Tools' })
    const panel = within(region).getByRole('tabpanel')
    const body = tablist.parentElement!
    // One column: the tabs first, then the tool (no side rail beside it).
    expect(body).toBe(panel.parentElement)
    expect(body).toHaveClass('flex-col')
    expect(body.firstElementChild).toBe(tablist)
    expect(tablist).toHaveAttribute('aria-orientation', 'horizontal')
    expect(tablist).toHaveClass('mx-auto')
  })

  it('centred content: the tab panel is a flex column that each tool fills with its scroll body, also after roll-up', async () => {
    const { region, user } = renderWidget()
    const panel = (): HTMLElement => within(region).getByRole('tabpanel')

    for (const tool of ['Tasks', 'Timer', 'Stopwatch']) {
      await user.click(within(region).getByRole('tab', { name: tool }))
      expect(panel()).toHaveClass('flex', 'flex-col', 'flex-1', 'min-h-0')
      // The tool fills the panel; its scroll body holds one centred block.
      expect(panel().children).toHaveLength(1)
      expect(panel().firstElementChild).toHaveClass('flex-1', 'min-h-0')
      const body = panel().querySelector('[data-tool-body]') as HTMLElement
      expect(body).toHaveClass('overflow-y-auto')
      expect(body.firstElementChild).toHaveAttribute('data-tool-content')
    }

    await user.dblClick(within(region).getByRole('heading', { name: 'Stopwatch' }))
    expect(within(region).queryByRole('tabpanel')).toBeNull()
    await user.dblClick(within(region).getByRole('heading', { name: 'Stopwatch' }))
    const body = panel().querySelector('[data-tool-body]') as HTMLElement
    expect(body).toBe(within(region).getByRole('group', { name: 'Stopwatch' }))
    expect(body.firstElementChild).toHaveClass('my-auto')
  })

  it('round 2: both counting tools wear the running dot on their tab', () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const { region } = renderWidget({}, { status: 'running', endsAt: T0 + 60_000 }, false, {
      status: 'running',
      startedAt: T0
    })

    expect(within(region).getByRole('tab', { name: 'Timer' })).toHaveAccessibleDescription(
      'Running'
    )
    expect(within(region).getByRole('tab', { name: 'Stopwatch' })).toHaveAccessibleDescription(
      'Running'
    )
  })

  it('round 2: rolled up on the Stopwatch tab, the header shows the running stopwatch', () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const { region } = renderWidget({ rolledUp: true, activeTool: 'stopwatch' }, {}, false, {
      status: 'running',
      startedAt: T0 - 65_000
    })

    const header = within(region).getByRole('timer', { name: 'Elapsed time' })
    expect(header).toHaveTextContent('0:01:05.0')
    act(() => {
      vi.advanceTimersByTime(2_300)
    })
    expect(header).toHaveTextContent('0:01:07.3')
  })

  it('round 2: rolled up on another tab, a running stopwatch stays out of the header', () => {
    const { region } = renderWidget({ rolledUp: true, activeTool: 'tasks' }, {}, false, {
      status: 'running',
      startedAt: Date.now()
    })

    expect(within(region).queryByRole('timer')).toBeNull()
  })

  it('round 2: rolled up with both counting, the timer keeps the header', () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const { region } = renderWidget(
      { rolledUp: true, activeTool: 'stopwatch' },
      { status: 'running', endsAt: T0 + 754_000 },
      false,
      { status: 'running', startedAt: T0 - 5_000 }
    )

    expect(within(region).getAllByRole('timer')).toHaveLength(1)
    expect(within(region).getByRole('timer', { name: 'Time left' })).toHaveTextContent('12:34')
  })

  it('double-clicking the title rolls it up to its header (the width is kept)', async () => {
    const { region, user } = renderWidget()

    await user.dblClick(within(region).getByRole('heading', { name: 'Tasks' }))

    expect(currentTools().rolledUp).toBe(true)
    expect(region).toHaveStyle({ height: '36px', width: '320px' })
    expect(within(region).queryByRole('tablist')).toBeNull()
    expect(currentTools().h).toBe(400)
  })

  it('the rolled-up header shows the remaining time while a timer runs', () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const { region } = renderWidget({ rolledUp: true }, { status: 'running', endsAt: T0 + 754_000 })

    expect(within(region).getByRole('timer', { name: 'Time left' })).toHaveTextContent('12:34')

    act(() => {
      vi.advanceTimersByTime(4_000)
    })
    expect(within(region).getByRole('timer', { name: 'Time left' })).toHaveTextContent('12:30')
  })

  it('the rolled-up header shows no time when no timer runs', () => {
    const { region } = renderWidget({ rolledUp: true })

    expect(within(region).queryByRole('timer')).toBeNull()
  })

  it('moves by its title bar (snapped, inside the work area) and saves once on release', async () => {
    const { region, user } = renderWidget()
    const title = within(region).getByRole('heading', { name: 'Tasks' })

    await user.pointer([
      { keys: '[MouseLeft>]', target: title, coords: { clientX: 260, clientY: 138 } },
      { coords: { clientX: 300, clientY: 170 } },
      { coords: { clientX: 363, clientY: 219 } }
    ])
    expect(region).toHaveStyle({ left: '304px', top: '208px' })
    expect(currentTools()).toMatchObject({ x: 200, y: 120 })

    await user.pointer({ keys: '[/MouseLeft]' })
    expect(currentTools()).toMatchObject({ x: 304, y: 208, w: 320, h: 400 })
  })

  it('resizes from a handle and stops at the 280 × 220 minimum', async () => {
    const { user } = renderWidget()
    const handle = document.querySelector('[data-resize-edge="se"]') as HTMLElement

    await user.pointer([
      { keys: '[MouseLeft>]', target: handle, coords: { clientX: 520, clientY: 520 } },
      { coords: { clientX: 100, clientY: 100 } },
      { keys: '[/MouseLeft]' }
    ])

    expect(currentTools()).toMatchObject({ x: 200, y: 120, w: 280, h: 220 })
  })

  it('clicks on it never end a Peek (it is a Peek-keep panel, like a group)', () => {
    const { region } = renderWidget()

    expect(region).toHaveAttribute('data-peek-keep')
    expect(
      within(region).getByRole('textbox', { name: 'Add a task' }).closest(PEEK_KEEP_SELECTOR)
    ).toBe(region)
  })

  it('quick-hide fades it out and makes it inert, like a group', () => {
    const { region } = renderWidget({}, {}, true)

    expect(region).toHaveAttribute('inert')
    expect(region).toHaveClass('opacity-0')
  })

  it('"Hide tools widget" in its menu hides it on this display', async () => {
    const { region, user } = renderWidget()

    await user.click(within(region).getByRole('button', { name: 'Tools options' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Hide tools widget' }))

    expect(currentTools().visible).toBe(false)
    expect(useUiStore.getState().toasts).toEqual([])
  })
})
