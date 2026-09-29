import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { defaultStopwatch, emptyTasks } from '@shared/defaults'
import type { StopwatchState, Task, TasksFile } from '@shared/schema'
import { useTasksStore } from '../../../stores/tasks'
import { createFakeBridge, installFakeBridge, type FakeBridge } from '../../../test/fake-bridge'
import { StopwatchTool } from './StopwatchTool'

const T0 = Date.UTC(2026, 8, 28, 10, 0, 0)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

function setup({
  stopwatch = {},
  tasks = []
}: { stopwatch?: Partial<StopwatchState>; tasks?: Task[] } = {}): {
  bridge: FakeBridge
  user: ReturnType<typeof userEvent.setup>
  container: HTMLElement
} {
  const bridge = installFakeBridge(createFakeBridge())
  act(() => {
    useTasksStore.getState().receive({
      revision: 1,
      data: { ...emptyTasks(), tasks, stopwatch: { ...defaultStopwatch(), ...stopwatch } }
    })
  })
  const { container } = render(<StopwatchTool />)
  return { bridge, user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime }), container }
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

const clock = (): string => screen.getByRole('timer', { name: 'Elapsed time' }).textContent ?? ''
const task = (id: string, text: string, patch: Partial<Task> = {}): Task => ({
  id,
  text,
  done: false,
  order: 0,
  createdAt: 1,
  ...patch
})
const lapRows = (): string[] =>
  within(screen.getByRole('list', { name: 'Laps' }))
    .getAllByRole('listitem')
    .map((row) => row.textContent ?? '')

describe('StopwatchTool', () => {
  it('shows 0:00:00.0 in an h:mm:ss.t timer that is not a live region', async () => {
    const { container } = setup()

    const timer = screen.getByRole('timer', { name: 'Elapsed time' })
    expect(timer).toHaveTextContent('0:00:00.0')
    expect(timer).toHaveAttribute('aria-live', 'off')
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Lap' })).toBeDisabled()
    vi.useRealTimers() // axe schedules its own timers
    expect(await axe(container)).toHaveNoViolations()
  })

  it('Start counts up; Pause freezes; Resume continues; Reset goes back to zero', async () => {
    const { user } = setup()

    await user.click(screen.getByRole('button', { name: 'Start' }))
    advance(3_250)
    expect(clock()).toBe('0:00:03.2')

    await user.click(screen.getByRole('button', { name: 'Pause' }))
    advance(10_000)
    expect(clock()).toBe('0:00:03.2')
    expect(screen.getByText('Paused')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Resume' }))
    advance(1_000)
    expect(clock()).toBe('0:00:04.2')

    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(clock()).toBe('0:00:00.0')
    expect(useTasksStore.getState().stopwatch).toEqual(defaultStopwatch())
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled()
  })

  it('Lap adds a row with its split and total, newest first', async () => {
    const { user, container } = setup()
    expect(screen.queryByRole('list', { name: 'Laps' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Start' }))
    advance(1_500)
    await user.click(screen.getByRole('button', { name: 'Lap' }))
    advance(2_000)
    await user.click(screen.getByRole('button', { name: 'Lap' }))

    expect(lapRows()).toEqual(['Lap 20:00:02.00:00:03.5', 'Lap 10:00:01.50:00:01.5'])
    expect(useTasksStore.getState().stopwatch.laps).toHaveLength(2)
    expect(
      screen.getByRole('listitem', { name: 'Lap 2: split 0:00:02.0, total 0:00:03.5' })
    ).toBeVisible()
    vi.useRealTimers()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('counts from the saved startedAt, so a stopwatch started before a restart keeps going', () => {
    setup({ stopwatch: { status: 'running', startedAt: T0 - 90_000, accumulatedMs: 4_000 } })

    expect(clock()).toBe('0:01:34.0')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeVisible()
    advance(1_000)
    expect(clock()).toBe('0:01:35.0')
  })

  it('Space toggles Start and Pause while the stopwatch view has focus', async () => {
    const { user } = setup()
    const view = screen.getByRole('group', { name: 'Stopwatch' })
    expect(view).toHaveAttribute('tabindex', '0')
    view.focus()

    await user.keyboard(' ')
    expect(useTasksStore.getState().stopwatch.status).toBe('running')
    await user.keyboard(' ')
    expect(useTasksStore.getState().stopwatch.status).toBe('paused')
    await user.keyboard(' ')
    expect(useTasksStore.getState().stopwatch.status).toBe('running')
  })

  it('Space on a button activates that button only', async () => {
    const { user } = setup({ stopwatch: { status: 'running', startedAt: T0 } })
    advance(500)
    screen.getByRole('button', { name: 'Lap' }).focus()

    await user.keyboard(' ')

    expect(useTasksStore.getState().stopwatch).toMatchObject({ status: 'running' })
    expect(useTasksStore.getState().stopwatch.laps).toHaveLength(1)
  })

  it('"Focus on…" links an active task, shown as one truncated line under the ring', async () => {
    const text = 'Write the quarterly report for the board and send it to everyone involved'
    const { user, bridge } = setup({
      tasks: [task('a', text), task('b', 'Done already', { done: true, completedAt: 1 })]
    })
    const picker = screen.getByRole('combobox', { name: 'Focus on…' })
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['No task', text])

    await user.selectOptions(picker, 'a')

    expect(useTasksStore.getState().stopwatch.linkedTaskId).toBe('a')
    const line = screen.getByText(`Focus: ${text}`)
    expect(line).toHaveClass('truncate')
    expect(line).toHaveAttribute('title', `Focus: ${text}`)
    expect(screen.getByTestId('stopwatch-ring')).not.toContainElement(line)
    await vi.waitFor(() =>
      expect((bridge.storage.save.mock.calls.at(-1)?.[1].data as TasksFile).stopwatch).toEqual({
        ...defaultStopwatch(),
        linkedTaskId: 'a'
      })
    )
  })
})
