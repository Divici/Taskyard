import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TIMER, emptyTasks } from '@shared/defaults'
import type { Task, TasksFile } from '@shared/schema'
import { FakeMain } from '@shared/test/fake-main'
import { SCHEMA_VERSION } from '@shared/version'
import { installFakeBridge } from '../test/fake-bridge'
import { createTasksStore } from './tasks'

const task: Task = { id: 't-1', text: 'Water plants', done: false, order: 0, createdAt: 1 }

function twoWindows(start: TasksFile = emptyTasks()): {
  main: FakeMain<TasksFile>
  a: ReturnType<typeof createTasksStore>
  b: ReturnType<typeof createTasksStore>
} {
  const main = new FakeMain<TasksFile>(start)
  const [a, b] = [main.connect(), main.connect()].map((window) => {
    const store = createTasksStore({ transport: window.transport })
    window.receive = (snapshot) => store.getState().receive(snapshot)
    store.getState().receive(main.snapshot())
    return store
  })
  return { main, a, b }
}

describe('tasks store', () => {
  it('receives tasks and timer from tasks.json', () => {
    const store = createTasksStore()
    const running = { ...DEFAULT_TIMER, status: 'running' as const, endsAt: 99 }

    store.getState().receive({ revision: 1, data: { version: 1, tasks: [task], timer: running } })

    expect(store.getState().tasks).toEqual([task])
    expect(store.getState().timer).toEqual(running)
    expect(store.getState().hydrated).toBe(true)
  })

  it('addTask persists the whole tasks file, stamped with the shared schema version', async () => {
    const bridge = installFakeBridge()
    const store = createTasksStore()
    store.getState().receive({ revision: 1, data: emptyTasks() })

    store.getState().addTask({ id: 't-1', text: 'Water plants', done: false, createdAt: 1 })

    await vi.waitFor(() =>
      expect(bridge.storage.save).toHaveBeenCalledExactlyOnceWith('tasks', {
        baseRevision: 1,
        data: { version: SCHEMA_VERSION, tasks: [task], timer: DEFAULT_TIMER }
      })
    )
  })

  it('updateTimer persists alongside the current tasks', async () => {
    const bridge = installFakeBridge()
    const store = createTasksStore()
    store.getState().receive({ revision: 1, data: { ...emptyTasks(), tasks: [task] } })

    store.getState().updateTimer((timer) => ({ ...timer, status: 'paused', remainingMs: 60_000 }))

    await vi.waitFor(() =>
      expect(bridge.storage.save).toHaveBeenCalledExactlyOnceWith('tasks', {
        baseRevision: 1,
        data: {
          version: SCHEMA_VERSION,
          tasks: [task],
          timer: { ...DEFAULT_TIMER, status: 'paused', remainingMs: 60_000 }
        }
      })
    )
  })

  it('offers no whole-list or whole-timer replacement', () => {
    const state = createTasksStore().getState() as unknown as Record<string, unknown>

    expect(state['replaceTasks']).toBeUndefined()
    expect(state['setTimer']).toBeUndefined()
  })

  it('two windows adding a task at once keep both tasks, with distinct order', async () => {
    const { main, a, b } = twoWindows()

    a.getState().addTask({ id: 'from-a', text: 'A', done: false, createdAt: 1 })
    b.getState().addTask({ id: 'from-b', text: 'B', done: false, createdAt: 2 })
    await main.settle('lifo')

    expect(main.data.tasks.map((t) => t.id).sort()).toEqual(['from-a', 'from-b'])
    expect(new Set(main.data.tasks.map((t) => t.order)).size).toBe(2)
    expect(a.getState().tasks).toEqual(main.data.tasks)
    expect(b.getState().tasks).toEqual(main.data.tasks)
  })

  it('two windows editing different fields of one task at once keep both edits', async () => {
    const { main, a, b } = twoWindows({ ...emptyTasks(), tasks: [task] })

    a.getState().updateTask('t-1', { text: 'Water the plants' })
    b.getState().updateTask('t-1', { done: true, completedAt: 5 })
    await main.settle()

    expect(main.data.tasks).toEqual([
      { ...task, text: 'Water the plants', done: true, completedAt: 5 }
    ])
    expect(a.getState().tasks).toEqual(main.data.tasks)
    expect(b.getState().tasks).toEqual(main.data.tasks)
  })

  it('a timer change in one window and a new task in another both survive', async () => {
    const { main, a, b } = twoWindows()

    a.getState().updateTimer((timer) => ({ ...timer, durationMs: 300_000 }))
    b.getState().addTask({ id: 'n', text: 'New', done: false, createdAt: 3 })
    await main.settle('lifo')

    expect(main.data.timer.durationMs).toBe(300_000)
    expect(main.data.tasks.map((t) => t.id)).toEqual(['n'])
  })

  it('removeTask, reorderTasks and clearCompleted persist through the same protocol', async () => {
    const { main, a } = twoWindows()
    for (const id of ['x', 'y', 'z']) {
      a.getState().addTask({ id, text: id, done: false, createdAt: 1 })
    }
    await main.settle()

    a.getState().reorderTasks(['z', 'x', 'y'])
    a.getState().updateTask('x', { done: true, completedAt: 9 })
    a.getState().clearCompleted()
    a.getState().removeTask('y')
    await main.settle()

    expect(main.data.tasks.map((t) => t.id)).toEqual(['z'])
    expect(a.getState().tasks).toEqual(main.data.tasks)
  })

  it('snapshots task and patch arguments when called', async () => {
    const bridge = installFakeBridge()
    const store = createTasksStore()
    const added = { id: 'a', text: 'Original', done: false, createdAt: 1 }
    const patch = { text: 'Patched' }

    store.getState().addTask(added)
    store.getState().updateTask('a', patch)
    added.text = 'mutated'
    patch.text = 'mutated'
    store.getState().receive({ revision: 1, data: emptyTasks() })

    await vi.waitFor(() => expect(bridge.storage.save).toHaveBeenCalled())
    const saved = bridge.storage.save.mock.calls.at(-1)?.[1].data as TasksFile | undefined
    expect(saved?.tasks[0].text).toBe('Patched')
  })

  it('does not send a change that changes nothing', async () => {
    const bridge = installFakeBridge()
    const store = createTasksStore()
    store.getState().receive({ revision: 1, data: { ...emptyTasks(), tasks: [task] } })

    store.getState().updateTask('missing', { text: 'x' })
    store.getState().removeTask('missing')
    store.getState().clearCompleted()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(bridge.storage.save).not.toHaveBeenCalled()
  })
})
