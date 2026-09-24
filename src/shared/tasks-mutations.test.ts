import { describe, expect, it } from 'vitest'
import { defaultTimer, emptyTasks } from './defaults'
import type { Task, TasksFile } from './schema'
import {
  addTask,
  clearCompleted,
  removeTask,
  reorderTasks,
  updateTask,
  updateTimer
} from './tasks-mutations'

function task(id: string, patch: Partial<Task> = {}): Task {
  return { id, text: `Task ${id}`, done: false, order: 0, createdAt: 1, ...patch }
}

function file(...tasks: Task[]): TasksFile {
  return { ...emptyTasks(), tasks }
}

describe('addTask', () => {
  it('appends the task with the next order, computed from the file it is applied to', () => {
    const start = file(task('a', { order: 0 }), task('b', { order: 4 }))

    const result = addTask(start, { id: 'c', text: 'New', done: false, createdAt: 9 })

    expect(result.tasks.at(-1)).toEqual({
      id: 'c',
      text: 'New',
      done: false,
      createdAt: 9,
      order: 5
    })
  })

  it('starts at order 0 in an empty list, and ignores an id that already exists', () => {
    const first = addTask(file(), { id: 'a', text: 'A', done: false, createdAt: 1 })
    expect(first.tasks[0].order).toBe(0)

    expect(addTask(first, { id: 'a', text: 'again', done: false, createdAt: 2 })).toBe(first)
  })
})

describe('updateTask', () => {
  it('changes only the fields in the patch', () => {
    const start = file(task('a', { text: 'Old', order: 3 }))

    const result = updateTask(start, 'a', { text: 'New' })

    expect(result.tasks).toEqual([task('a', { text: 'New', order: 3 })])
  })

  it('removes a field patched to undefined (unchecking clears completedAt)', () => {
    const start = file(task('a', { done: true, completedAt: 5 }))

    const result = updateTask(start, 'a', { done: false, completedAt: undefined })

    expect(result.tasks[0]).toEqual(task('a'))
    expect('completedAt' in result.tasks[0]).toBe(false)
  })

  it('is a no-op (same object) for a task that no longer exists or an empty change', () => {
    const start = file(task('a'))

    expect(updateTask(start, 'gone', { text: 'x' })).toBe(start)
    expect(updateTask(start, 'a', { text: 'Task a' })).toBe(start)
  })
})

describe('removeTask', () => {
  it('removes the task and unlinks the timer from it', () => {
    const start: TasksFile = {
      ...file(task('a'), task('b')),
      timer: { ...defaultTimer(), linkedTaskId: 'a' }
    }

    const result = removeTask(start, 'a')

    expect(result.tasks.map((t) => t.id)).toEqual(['b'])
    expect('linkedTaskId' in result.timer).toBe(false)
  })

  it('is a no-op for an unknown id', () => {
    const start = file(task('a'))

    expect(removeTask(start, 'x')).toBe(start)
  })
})

describe('reorderTasks', () => {
  it('orders the listed tasks as given and renumbers order', () => {
    const start = file(task('a', { order: 0 }), task('b', { order: 1 }), task('c', { order: 2 }))

    const result = reorderTasks(start, ['c', 'a', 'b'])

    expect(result.tasks.map((t) => [t.id, t.order])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2]
    ])
  })

  it('keeps tasks it was not told about (added elsewhere meanwhile) after the listed ones', () => {
    const start = file(task('a', { order: 0 }), task('new', { order: 1 }), task('b', { order: 2 }))

    const result = reorderTasks(start, ['b', 'gone', 'a'])

    expect(result.tasks.map((t) => t.id)).toEqual(['b', 'a', 'new'])
  })
})

describe('clearCompleted', () => {
  it('removes done tasks and unlinks the timer from a removed one', () => {
    const start: TasksFile = {
      ...file(task('a', { done: true, completedAt: 2 }), task('b')),
      timer: { ...defaultTimer(), linkedTaskId: 'a' }
    }

    const result = clearCompleted(start)

    expect(result.tasks.map((t) => t.id)).toEqual(['b'])
    expect(result.timer.linkedTaskId).toBeUndefined()
  })

  it('is a no-op when nothing is done', () => {
    const start = file(task('a'))

    expect(clearCompleted(start)).toBe(start)
  })
})

describe('updateTimer', () => {
  it('applies the updater to the timer in the file it is replayed on', () => {
    const start = file(task('a'))

    const result = updateTimer(start, (timer) => ({ ...timer, durationMs: 300_000 }))

    expect(result.timer.durationMs).toBe(300_000)
    expect(result.tasks).toBe(start.tasks)
  })

  it('is a no-op when the updater returns the same timer', () => {
    const start = file()

    expect(updateTimer(start, (timer) => timer)).toBe(start)
  })
})
