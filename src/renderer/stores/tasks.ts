import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { emptyTasks } from '@shared/defaults'
import type { StoreSnapshot } from '@shared/ipc'
import type { Task, TimerState } from '@shared/schema'
import {
  addTask,
  clearCompleted,
  removeTask,
  reorderTasks,
  updateTask,
  updateTimer,
  type NewTask,
  type TaskPatch
} from '@shared/tasks-mutations'
import { createStoreDoc, type StoreSyncOptions } from './persist'

/**
 * tasks.json in the renderer. Every change is a domain primitive applied to the file as it is
 * *now* (src/shared/tasks-mutations.ts), so two windows editing at once never lose each other's
 * change. There is deliberately no "replace all tasks" / "replace the timer".
 */
export interface TasksState {
  tasks: Task[]
  timer: TimerState
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
  /** Forgets main's data, the revision and unsaved changes; back to unhydrated (tests). */
  reset(): void
}

export function createTasksStore(
  options: StoreSyncOptions<'tasks'> = {}
): UseBoundStore<StoreApi<TasksState>> {
  return create<TasksState>()((set) => {
    const doc = createStoreDoc(
      'tasks',
      emptyTasks,
      (file) => set({ tasks: file.tasks, timer: file.timer }),
      options
    )

    return {
      tasks: doc.current.view.tasks,
      timer: doc.current.view.timer,
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

      reset() {
        const view = doc.reset().view
        set({ tasks: view.tasks, timer: view.timer, hydrated: false })
      }
    }
  })
}

export const useTasksStore = createTasksStore()
