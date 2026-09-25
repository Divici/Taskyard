import { describe, expect, it } from 'vitest'
import { defaultTimer, emptyTasks } from '@shared/defaults'
import type { TasksFile, TimerState } from '@shared/schema'
import { FakeMain } from '@shared/test/fake-main'
import { createTasksStore } from './tasks'
import { createTimerController, type TimerController } from './timer'

const T0 = 1_700_000_000_000

interface Setup {
  main: FakeMain<TasksFile>
  tasks: ReturnType<typeof createTasksStore>
  timer: TimerController
  /** The controller's clock: `advance` returns the new time. */
  clock: { set(value: number): number; advance(ms: number): number }
  /** Delivers main's tasks.json to the store (hydration). */
  hydrate(): void
}

function setup(timer: Partial<TimerState> = {}, start: Partial<TasksFile> = {}): Setup {
  const main = new FakeMain<TasksFile>({
    ...emptyTasks(),
    ...start,
    timer: { ...defaultTimer(), ...timer }
  })
  const window = main.connect()
  const tasks = createTasksStore({ transport: window.transport })
  window.receive = (snapshot) => tasks.getState().receive(snapshot)
  let now = T0
  const clock = {
    set: (value: number) => (now = value),
    advance: (ms: number) => (now += ms)
  }
  const timerCtl = createTimerController({ tasks, now: () => now })
  const hydrate = (): void => tasks.getState().receive(main.snapshot())
  return { main, tasks, timer: timerCtl, clock, hydrate }
}

describe('timer controller', () => {
  it('start stores an absolute endsAt in tasks.json', async () => {
    const { main, timer, hydrate } = setup({ durationMs: 120_000 })
    hydrate()

    timer.start()
    await main.settle()

    expect(main.data.timer).toEqual({
      ...defaultTimer(),
      durationMs: 120_000,
      status: 'running',
      endsAt: T0 + 120_000
    })
  })

  it('pause, resume and stop change the persisted timer', async () => {
    const { main, timer, clock, hydrate } = setup({ durationMs: 300_000 })
    hydrate()

    timer.start()
    clock.advance(60_000)
    timer.pause()
    await main.settle()
    expect(main.data.timer).toMatchObject({ status: 'paused', remainingMs: 240_000 })

    clock.advance(600_000)
    timer.resume()
    await main.settle()
    expect(main.data.timer).toMatchObject({ status: 'running', endsAt: clock.advance(0) + 240_000 })

    timer.stop()
    await main.settle()
    expect(main.data.timer).toEqual({ ...defaultTimer(), durationMs: 300_000 })
  })

  it('setDuration validates whole minutes 1–180 and reports whether it applied', async () => {
    const { main, timer, hydrate } = setup()
    hydrate()

    expect(timer.setDuration(45 * 60_000)).toBe(true)
    expect(timer.setDuration(0)).toBe(false)
    expect(timer.setDuration(181 * 60_000)).toBe(false)
    await main.settle()

    expect(main.data.timer.durationMs).toBe(45 * 60_000)
  })

  it('hydrate recomputes the remaining time from endsAt', () => {
    const { timer, clock, hydrate } = setup({ status: 'running', endsAt: T0 + 90_000 })
    hydrate()
    clock.advance(30_000)

    expect(timer.hydrate()).toBe(false)
    expect(timer.remaining()).toBe(60_000)
  })

  it('hydrate past endsAt enters finished, noting it finished while you were away', async () => {
    const { main, tasks, timer, clock, hydrate } = setup({
      status: 'running',
      endsAt: T0 + 90_000,
      linkedTaskId: 't'
    })
    hydrate()
    clock.advance(5 * 60_000)

    expect(timer.hydrate()).toBe(true)
    await main.settle()

    expect(tasks.getState().timer).toMatchObject({ status: 'finished', finishedAway: true })
    expect(main.data.timer).not.toHaveProperty('endsAt')
    expect(timer.remaining()).toBe(0)
  })

  it('finishIfDue finishes a running timer once its time has come (no away note)', async () => {
    const { main, timer, clock, hydrate } = setup({ durationMs: 60_000 })
    hydrate()
    timer.start()

    clock.advance(59_000)
    expect(timer.finishIfDue()).toBe(false)
    clock.advance(1_000)
    expect(timer.finishIfDue()).toBe(true)
    expect(timer.finishIfDue()).toBe(false)
    await main.settle()

    expect(main.data.timer.status).toBe('finished')
    expect(main.data.timer.finishedAway).toBeUndefined()
  })

  it('acknowledge dismisses the finished state', async () => {
    const { main, timer, hydrate } = setup({ status: 'finished', finishedAway: true })
    hydrate()

    timer.acknowledge()
    await main.settle()

    expect(main.data.timer).toEqual(defaultTimer())
  })

  it('linkTask focuses the timer on a task, and the link clears when the task is deleted', async () => {
    const task = { id: 't-1', text: 'Write report', done: false, order: 0, createdAt: 1 }
    const { main, tasks, timer, hydrate } = setup({}, { tasks: [task] })
    hydrate()

    timer.linkTask('t-1')
    await main.settle()
    expect(main.data.timer.linkedTaskId).toBe('t-1')

    tasks.getState().removeTask('t-1')
    await main.settle()
    expect(main.data.timer).not.toHaveProperty('linkedTaskId')

    timer.linkTask('t-1')
    timer.linkTask(null)
    await main.settle()
    expect(main.data.timer).not.toHaveProperty('linkedTaskId')
  })
})
