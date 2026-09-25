import type { Task, TasksFile, TimerState } from './schema'

// Pure changes to tasks.json. The renderer's sync client replays them on newer data whenever
// another window saved first (src/shared/sync-doc.ts), so each one works on the file it is
// applied to — never on a list or timer captured earlier — and returns the same object when
// nothing changes. There is deliberately no "replace all tasks" or "replace the timer": that
// would silently drop another window's edit on replay.

/** A new task; its `order` is assigned when the change is applied. */
export type NewTask = Omit<Task, 'order'>

/** Fields of a task to change; a field set to `undefined` is removed (e.g. `completedAt`). */
export type TaskPatch = Partial<Omit<Task, 'id'>>

function withoutLink(timer: TimerState, removed: ReadonlySet<string>): TimerState {
  if (timer.linkedTaskId === undefined || !removed.has(timer.linkedTaskId)) return timer
  const next = { ...timer }
  delete next.linkedTaskId
  return next
}

function removeTasks(file: TasksFile, ids: ReadonlySet<string>): TasksFile {
  if (!file.tasks.some((task) => ids.has(task.id))) return file
  return {
    ...file,
    tasks: file.tasks.filter((task) => !ids.has(task.id)),
    timer: withoutLink(file.timer, ids)
  }
}

/** Appends the task after every existing one. A task whose id already exists is ignored. */
export function addTask(file: TasksFile, task: NewTask): TasksFile {
  if (file.tasks.some((existing) => existing.id === task.id)) return file
  const order = file.tasks.reduce((max, existing) => Math.max(max, existing.order), -1) + 1
  return { ...file, tasks: [...file.tasks, { ...task, order }] }
}

/** Changes only the patched fields of one task; a no-op if the task is gone. */
export function updateTask(file: TasksFile, id: string, patch: TaskPatch): TasksFile {
  const index = file.tasks.findIndex((task) => task.id === id)
  if (index === -1) return file
  const current = file.tasks[index]
  const next: Task = { ...current }
  let changed = false
  for (const [key, value] of Object.entries(patch) as Array<[keyof TaskPatch, unknown]>) {
    if (value === undefined) {
      if (key in next) {
        delete next[key]
        changed = true
      }
    } else if (next[key] !== value) {
      ;(next as Record<string, unknown>)[key] = value
      changed = true
    }
  }
  if (!changed) return file
  return { ...file, tasks: file.tasks.map((task, i) => (i === index ? next : task)) }
}

/**
 * Checks or unchecks a task. Completing stamps `completedAt` (the task keeps its `order`);
 * unchecking removes it and moves the task after every other one, i.e. to the bottom of the
 * active list. A no-op when the task is gone or already in that state.
 */
export function setTaskDone(file: TasksFile, id: string, done: boolean, now: number): TasksFile {
  const current = file.tasks.find((task) => task.id === id)
  if (!current || current.done === done) return file
  if (done) return updateTask(file, id, { done: true, completedAt: now })
  const order = file.tasks.reduce((max, task) => Math.max(max, task.order), -1) + 1
  return updateTask(file, id, { done: false, completedAt: undefined, order })
}

/** Removes one task, and unlinks the timer if it was focused on it. */
export function removeTask(file: TasksFile, id: string): TasksFile {
  return removeTasks(file, new Set([id]))
}

/**
 * Puts the listed tasks first, in that order, then every task the list did not mention (one
 * another window added meanwhile) in its current order, and renumbers `order` from 0.
 */
export function reorderTasks(file: TasksFile, ids: readonly string[]): TasksFile {
  const byId = new Map(file.tasks.map((task) => [task.id, task]))
  const listed = ids.flatMap((id) => {
    const task = byId.get(id)
    byId.delete(id)
    return task ? [task] : []
  })
  const rest = file.tasks.filter((task) => byId.has(task.id))
  const tasks = [...listed, ...rest].map((task, order) =>
    task.order === order ? task : { ...task, order }
  )
  const same = tasks.every((task, index) => task === file.tasks[index])
  return same ? file : { ...file, tasks }
}

/** Removes every done task (and unlinks the timer from one). */
export function clearCompleted(file: TasksFile): TasksFile {
  return removeTasks(file, new Set(file.tasks.filter((task) => task.done).map((task) => task.id)))
}

/** Applies `update` to the timer of the file it is replayed on. */
export function updateTimer(file: TasksFile, update: (timer: TimerState) => TimerState): TasksFile {
  const timer = update(file.timer)
  return timer === file.timer ? file : { ...file, timer }
}
