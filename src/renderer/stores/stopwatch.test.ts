import { describe, expect, it } from 'vitest'
import { defaultStopwatch, emptyTasks } from '@shared/defaults'
import type { StopwatchState, TasksFile } from '@shared/schema'
import { FakeMain } from '@shared/test/fake-main'
import { createStopwatchController, type StopwatchController } from './stopwatch'
import { createTasksStore } from './tasks'

const T0 = 1_700_000_000_000

interface Setup {
  main: FakeMain<TasksFile>
  tasks: ReturnType<typeof createTasksStore>
  stopwatch: StopwatchController
  clock: { advance(ms: number): number }
}

function setup(watch: Partial<StopwatchState> = {}, start: Partial<TasksFile> = {}): Setup {
  const main = new FakeMain<TasksFile>({
    ...emptyTasks(),
    ...start,
    stopwatch: { ...defaultStopwatch(), ...watch }
  })
  const window = main.connect()
  const tasks = createTasksStore({ transport: window.transport })
  window.receive = (snapshot) => tasks.getState().receive(snapshot)
  tasks.getState().receive(main.snapshot())
  let now = T0
  const clock = { advance: (ms: number) => (now += ms) }
  return { main, tasks, stopwatch: createStopwatchController({ tasks, now: () => now }), clock }
}

describe('stopwatch controller', () => {
  it('start stores an absolute startedAt in tasks.json and counts up from it', async () => {
    const { main, stopwatch, clock } = setup()

    stopwatch.start()
    await main.settle()
    expect(main.data.stopwatch).toEqual({ ...defaultStopwatch(), status: 'running', startedAt: T0 })

    clock.advance(4_200)
    expect(stopwatch.elapsed()).toBe(4_200)
  })

  it('toggle starts, pauses and resumes (the Space shortcut)', async () => {
    const { main, stopwatch, clock } = setup()

    stopwatch.toggle()
    clock.advance(3_000)
    stopwatch.toggle()
    await main.settle()
    expect(main.data.stopwatch).toMatchObject({ status: 'paused', accumulatedMs: 3_000 })

    clock.advance(60_000)
    stopwatch.toggle()
    clock.advance(1_000)
    await main.settle()
    expect(main.data.stopwatch).toMatchObject({ status: 'running', accumulatedMs: 3_000 })
    expect(stopwatch.elapsed()).toBe(4_000)
  })

  it('lap and reset persist; the linked task survives a reset', async () => {
    const { main, stopwatch, clock } = setup(
      {},
      {
        tasks: [{ id: 't', text: 'Write report', done: false, order: 0, createdAt: 1 }]
      }
    )

    stopwatch.linkTask('t')
    stopwatch.start()
    clock.advance(1_500)
    stopwatch.lap()
    await main.settle()
    expect(main.data.stopwatch.laps).toEqual([{ n: 1, totalMs: 1_500, splitMs: 1_500 }])

    stopwatch.reset()
    await main.settle()
    expect(main.data.stopwatch).toEqual({ ...defaultStopwatch(), linkedTaskId: 't' })
  })

  it('reads the clock when the action is called, even if the save replays later', async () => {
    const { main, tasks, stopwatch, clock } = setup()
    stopwatch.start()
    clock.advance(2_000)
    stopwatch.pause()
    // Another window changes the timer meanwhile; the stopwatch keeps its own moment.
    tasks.getState().updateTimer((timer) => ({ ...timer, durationMs: 300_000 }))
    clock.advance(9_000)
    await main.settle('lifo')

    expect(main.data.stopwatch).toMatchObject({ status: 'paused', accumulatedMs: 2_000 })
  })
})
