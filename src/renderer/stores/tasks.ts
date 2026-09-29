import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { emptyTasks } from '@shared/defaults'
import type { StoreSnapshot } from '@shared/ipc'
import type { StopwatchState, Task, TimerState } from '@shared/schema'
import {
  addTask,
  clearCompleted,
  removeTask,
  reorderTasks,
  setTaskDone,
  updateStopwatch,
  updateTask,
  updateTimer,
  type NewTask,
  type TaskPatch
} from '@shared/tasks-mutations'
import { createStoreDoc, type StoreSyncOptions } from './persist'

/** A task's text is one line of at most this many characters (tasks.json's limit). */
export const TASK_TEXT_MAX = 500

/** One trimmed line, cut at the limit; null when nothing is left. */
export function cleanTaskText(text: string): string | null {
  const line = text.replace(/\s+/g, ' ').trim().slice(0, TASK_TEXT_MAX).trim()
  return line.length > 0 ? line : null
}

/**
 * tasks.json in the renderer. Every change is a domain primitive applied to the file as it is
 * *now* (src/shared/tasks-mutations.ts), so two windows editing at once never lose each other's
 * change. There is deliberately no "replace all tasks" / "replace the timer".
 */
export interface TasksState {
  tasks: Task[]
  timer: TimerState
  /** Round 2: the stopwatch (tasks.json's `stopwatch`). */
  stopwatch: StopwatchState
  hydrated: boolean
  /** Main's tasks file at a revision: the loaded file or a `storage:changed` event. Never saves. */
  receive(snapshot: StoreSnapshot<'tasks'>): void
  /** Appends a task; its `order` is assigned after every existing task. */
  addTask(task: NewTask): void
  /** Changes only the patched fields; a field patched to `undefined` is removed. */
  updateTask(id: string, patch: TaskPatch): void
  /** Removes a task (and unlinks the timer from it). */
  removeTask(id: string): void
  /** Listed ids first, in that order; tasks added elsewhere meanwhile keep their place after. */
  reorderTasks(ids: string[]): void
  /** Removes every done task. */
  clearCompleted(): void
  /** Field-level timer change: `update` receives the timer as it is now. */
  updateTimer(update: (timer: TimerState) => TimerState): void
  /** Round 2: field-level stopwatch change: `update` receives the stopwatch as it is now. */
  updateStopwatch(update: (stopwatch: StopwatchState) => StopwatchState): void
  // ---- Phase 10: the to-do list's actions (built on the primitives above) --------------------

  /** Adds a task at the end of the list; returns its id, or null when the text is blank. */
  add(text: string): string | null
  /** Changes a task's text; blank text changes nothing. */
  edit(id: string, text: string): void
  /** Checks or unchecks a task; unchecked, it goes to the bottom of the active list. */
  toggle(id: string): void
  /** Round 2: checks (true) or unchecks (false) a task; a no-op when it is already so. */
  setDone(id: string, done: boolean): void
  /** Forgets main's data, the revision and unsaved changes; back to unhydrated (tests). */
  reset(): void
}

export function createTasksStore(
  options: StoreSyncOptions<'tasks'> = {}
): UseBoundStore<StoreApi<TasksState>> {
  return create<TasksState>()((set, get) => {
    const doc = createStoreDoc(
      'tasks',
      emptyTasks,
      (file) => set({ tasks: file.tasks, timer: file.timer, stopwatch: file.stopwatch }),
      options
    )

    return {
      tasks: doc.current.view.tasks,
      timer: doc.current.view.timer,
      stopwatch: doc.current.view.stopwatch,
      hydrated: false,

      receive(snapshot) {
        doc.current.receive(snapshot)
        set({ hydrated: doc.current.hydrated })
      },

      addTask(task) {
        const added = { ...task } // copied now: changing the argument later cannot change a replay
        doc.current.mutate((file) => addTask(file, added))
      },

      updateTask(id, patch) {
        const change = { ...patch }
        doc.current.mutate((file) => updateTask(file, id, change))
      },

      removeTask(id) {
        doc.current.mutate((file) => removeTask(file, id))
      },

      reorderTasks(ids) {
        const order = [...ids]
        doc.current.mutate((file) => reorderTasks(file, order))
      },

      clearCompleted() {
        doc.current.mutate(clearCompleted)
      },

      updateTimer(update) {
        doc.current.mutate((file) => updateTimer(file, update))
      },

      updateStopwatch(update) {
        doc.current.mutate((file) => updateStopwatch(file, update))
      },

      add(text) {
        const line = cleanTaskText(text)
        if (line === null) return null
        const id = crypto.randomUUID()
        get().addTask({ id, text: line, done: false, createdAt: Date.now() })
        return id
      },

      edit(id, text) {
        const line = cleanTaskText(text)
        if (line !== null) get().updateTask(id, { text: line })
      },

      toggle(id) {
        const task = get().tasks.find((entry) => entry.id === id)
        // The wanted state is captured now; setTaskDone is a no-op if it is already so.
        if (task) get().setDone(id, !task.done)
      },

      setDone(id, done) {
        const now = Date.now()
        doc.current.mutate((file) => setTaskDone(file, id, done, now))
      },

      reset() {
        const view = doc.reset().view
        set({ tasks: view.tasks, timer: view.timer, stopwatch: view.stopwatch, hydrated: false })
      }
    }
  })
}

export const useTasksStore = createTasksStore()
