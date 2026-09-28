import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { defaultSettings, defaultTimer, emptyTasks } from '@shared/defaults'
import type { SettingsFile, Task, TimerState } from '@shared/schema'
import { useSettingsStore } from '../../../stores/settings'
import { useTasksStore } from '../../../stores/tasks'
import { useUiStore } from '../../../stores/ui'
import { createFakeBridge, installFakeBridge, type FakeBridge } from '../../../test/fake-bridge'
import { ConfirmHost } from '../../feedback/ConfirmDialog'
import { playChime } from './chime'
import { TimerCompletion } from './TimerCompletion'
import { RING_LABEL } from './ring-geometry'
import { TimerTool } from './TimerTool'

vi.mock('./chime', () => ({ playChime: vi.fn(async () => {}) }))

const T0 = Date.UTC(2026, 8, 25, 10, 0, 0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

interface Setup {
  bridge: FakeBridge
  user: ReturnType<typeof userEvent.setup>
  container: HTMLElement
}

function setup({
  timer = {},
  tasks = [],
  settings = {},
  leader = true
}: {
  timer?: Partial<TimerState>
  tasks?: Task[]
  settings?: Partial<SettingsFile>
  leader?: boolean
} = {}): Setup {
  const bridge = installFakeBridge(createFakeBridge())
  act(() => {
    useSettingsStore
      .getState()
      .receive({ revision: 1, data: { ...defaultSettings(), ...settings } })
    useTasksStore.getState().receive({
      revision: 1,
      data: { ...emptyTasks(), tasks, timer: { ...defaultTimer(), ...timer } }
    })
  })
  const { container } = render(
    <>
      <TimerCompletion leader={leader} />
      <TimerTool />
      <ConfirmHost />
    </>
  )
  return { bridge, user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime }), container }
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

const clock = (): string => screen.getByRole('timer').textContent ?? ''
const task = (id: string, text: string, patch: Partial<Task> = {}): Task => ({
  id,
  text,
  done: false,
  order: 0,
  createdAt: 1,
  ...patch
})

describe('TimerTool', () => {
  it('shows the chosen duration as a large mm:ss timer that is not a live region', async () => {
    const { container } = setup()

    const timer = screen.getByRole('timer', { name: 'Time left' })
    expect(timer).toHaveTextContent('25:00')
    expect(timer).toHaveAttribute('aria-live', 'off')
    vi.useRealTimers() // axe schedules its own timers
    expect(await axe(container)).toHaveNoViolations()
  })

  it('shows h:mm:ss past an hour', () => {
    setup({ timer: { durationMs: 90 * 60_000 } })

    expect(clock()).toBe('1:30:00')
  })

  it('Start counts down; Pause freezes; Resume continues; Stop resets', async () => {
    const { user } = setup()

    await user.click(screen.getByRole('button', { name: 'Start' }))
    advance(3_000)
    expect(clock()).toBe('24:57')

    await user.click(screen.getByRole('button', { name: 'Pause' }))
    advance(10_000)
    expect(clock()).toBe('24:57')
    expect(screen.getByText('Paused')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Resume' }))
    advance(2_000)
    expect(clock()).toBe('24:55')

    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(clock()).toBe('25:00')
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled()
  })

  it('presets choose the duration and are disabled with the custom input while running', async () => {
    const { user } = setup()
    const presets = within(screen.getByRole('group', { name: 'Presets' }))
    expect(presets.getAllByRole('button').map((b) => b.textContent)).toEqual([
      '5 min',
      '15 min',
      '25 min',
      '45 min'
    ])
    expect(presets.getByRole('button', { name: '25 min' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(presets.getByRole('button', { name: '5 min' }))
    expect(clock()).toBe('05:00')
    expect(presets.getByRole('button', { name: '5 min' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Start' }))
    for (const button of presets.getAllByRole('button')) expect(button).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Custom minutes' })).toBeDisabled()
  })

  it('the custom input takes 1–180 minutes and explains anything else', async () => {
    const { user } = setup()
    const custom = screen.getByRole('spinbutton', { name: 'Custom minutes' })
    expect(custom).toHaveAttribute('min', '1')
    expect(custom).toHaveAttribute('max', '180')

    await user.clear(custom)
    await user.type(custom, '181{Enter}')
    expect(custom).toHaveAttribute('aria-invalid', 'true')
    expect(custom).toHaveAccessibleDescription('Enter a whole number of minutes from 1 to 180.')
    expect(clock()).toBe('25:00')

    await user.clear(custom)
    await user.type(custom, '0{Enter}')
    expect(custom).toHaveAttribute('aria-invalid', 'true')

    await user.clear(custom)
    await user.type(custom, '90{Enter}')
    expect(custom).not.toHaveAttribute('aria-invalid')
    expect(clock()).toBe('1:30:00')
  })

  it('completion fires the toast, the Windows notification and the chime', async () => {
    const { bridge } = setup({
      timer: { status: 'running', endsAt: T0 + 2_000, linkedTaskId: 't' },
      tasks: [task('t', 'Write report')]
    })

    advance(2_250)

    expect(useUiStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: 'Timer finished',
        description: 'Time’s up for “Write report”.'
      })
    ])
    expect(bridge.timer.notify).toHaveBeenCalledExactlyOnceWith({
      endsAt: T0 + 2_000,
      taskText: 'Write report'
    })
    expect(playChime).toHaveBeenCalledOnce()
    expect(clock()).toBe('00:00')
    expect(screen.getByText('Time’s up')).toBeVisible()
    expect(screen.getByTestId('timer-ring')).toHaveAttribute('data-finished')
    expect(useTasksStore.getState().timer.status).toBe('finished')
  })

  it('completion skips the notification and the chime when Settings turn them off', () => {
    const { bridge } = setup({
      timer: { status: 'running', endsAt: T0 + 1_000 },
      settings: { timerSound: false, timerNotify: false }
    })

    advance(1_250)

    expect(useUiStore.getState().toasts).toHaveLength(1)
    expect(bridge.timer.notify).not.toHaveBeenCalled()
    expect(playChime).not.toHaveBeenCalled()
  })

  it('only the leader window (the primary display) raises the alerts', () => {
    const { bridge } = setup({ timer: { status: 'running', endsAt: T0 + 1_000 }, leader: false })

    advance(1_250)

    expect(clock()).toBe('00:00')
    expect(useUiStore.getState().toasts).toEqual([])
    expect(bridge.timer.notify).not.toHaveBeenCalled()
    expect(playChime).not.toHaveBeenCalled()
  })

  it('with a linked task, "Mark done" appears on completion and completes the task', async () => {
    const { user } = setup({
      timer: { status: 'running', endsAt: T0 + 1_000, linkedTaskId: 't' },
      tasks: [task('t', 'Write report')]
    })
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull()

    advance(1_250)
    await user.click(screen.getByRole('button', { name: 'Mark done' }))

    expect(useTasksStore.getState().tasks[0]).toMatchObject({ done: true })
    expect(screen.queryByRole('button', { name: 'Mark done' })).toBeNull()
  })

  it('a timer that ended while the app was closed shows the finished state, not a negative count', () => {
    const { bridge } = setup({ timer: { status: 'running', endsAt: T0 - 60_000 } })

    expect(clock()).toBe('00:00')
    expect(screen.getByText('Finished while you were away')).toBeVisible()
    expect(useTasksStore.getState().timer).toMatchObject({ status: 'finished', finishedAway: true })
    expect(bridge.timer.notify).not.toHaveBeenCalled()
    expect(playChime).not.toHaveBeenCalled()
  })

  it('"Focus on…" links an active task to the timer', async () => {
    const { user } = setup({
      tasks: [task('a', 'Write report'), task('b', 'Done already', { done: true, completedAt: 1 })]
    })
    const picker = screen.getByRole('combobox', { name: 'Focus on…' })
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['No task', 'Write report'])

    await user.selectOptions(picker, 'a')

    expect(useTasksStore.getState().timer.linkedTaskId).toBe('a')
  })

  it('Space toggles Start and Pause while the timer view has focus', async () => {
    const { user } = setup()
    screen.getByRole('group', { name: 'Timer' }).focus()

    await user.keyboard(' ')
    expect(useTasksStore.getState().timer.status).toBe('running')
    await user.keyboard(' ')
    expect(useTasksStore.getState().timer.status).toBe('paused')
    await user.keyboard(' ')
    expect(useTasksStore.getState().timer.status).toBe('running')
  })

  it('Esc on a running timer asks before stopping it', async () => {
    const { user } = setup({ timer: { status: 'running', endsAt: T0 + 60_000 } })
    screen.getByRole('group', { name: 'Timer' }).focus()

    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(useTasksStore.getState().timer.status).toBe('running')

    screen.getByRole('group', { name: 'Timer' }).focus()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('alertdialog', { name: 'Stop the timer?' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Stop timer' }))
    expect(useTasksStore.getState().timer.status).toBe('idle')
  })

  it('the timer view is in the Tab order, so its shortcuts are reachable by keyboard', async () => {
    const { user } = setup()
    const view = screen.getByRole('group', { name: 'Timer' })
    expect(view).toHaveAttribute('tabindex', '0')

    await user.tab()
    expect(view).toHaveFocus()
    await user.keyboard(' ')
    expect(useTasksStore.getState().timer.status).toBe('running')
  })

  it('Esc with focus on the Pause button asks before stopping', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Start' }))
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveFocus()

    await user.keyboard('{Escape}')

    expect(screen.getByRole('alertdialog', { name: 'Stop the timer?' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Stop timer' }))
    expect(useTasksStore.getState().timer.status).toBe('idle')
  })

  it('Esc inside the custom field or the task picker does not ask', async () => {
    const { user } = setup({ timer: { status: 'running', endsAt: T0 + 60_000 } })

    screen.getByRole('combobox', { name: 'Focus on…' }).focus()
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('Space on a button activates that button only (no extra toggle)', async () => {
    const { user } = setup()
    screen.getByRole('button', { name: '5 min' }).focus()

    await user.keyboard(' ')

    expect(useTasksStore.getState().timer).toMatchObject({ status: 'idle', durationMs: 300_000 })

    screen.getByRole('button', { name: 'Start' }).focus()
    await user.keyboard(' ')
    expect(useTasksStore.getState().timer.status).toBe('running')
  })

  it('announces politely at one minute left and at zero', () => {
    setup({ timer: { status: 'running', endsAt: T0 + 61_000 } })
    const live = screen.getByTestId('timer-announcer')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toHaveTextContent('')

    advance(1_500)
    expect(live).toHaveTextContent('1 minute left')

    advance(60_000)
    expect(live).toHaveTextContent('Timer finished')
  })
  it('Phase 12: a long "Focus: <task>" label is cut short inside the ring, with the full text as its title', () => {
    const text = 'Write the quarterly report for the board and send it to everyone involved'
    setup({
      tasks: [{ id: 't', text, done: false, order: 0, createdAt: 1 }],
      timer: { linkedTaskId: 't' }
    })
    const label = screen.getByText(`Focus: ${text}`)
    expect(label).toHaveClass('truncate')
    expect(label).toHaveStyle({ maxWidth: `${RING_LABEL.maxWidth}px` })
    expect(label).toHaveAttribute('title', `Focus: ${text}`)
  })
})
