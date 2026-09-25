import type { Task } from '@shared/schema'

/** The to-do list's two lists: active tasks by `order`, completed ones newest first. */
export function splitTasks(tasks: readonly Task[]): { active: Task[]; completed: Task[] } {
  const active = tasks
    .filter((task) => !task.done)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
  const completed = tasks
    .filter((task) => task.done)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0) || a.order - b.order)
  return { active, completed }
}

/** `ids` with `id` moved `delta` places (clamped to the list); null when it cannot move. */
export function moveId(ids: readonly string[], id: string, delta: number): string[] | null {
  const from = ids.indexOf(id)
  if (from === -1) return null
  const to = Math.min(ids.length - 1, Math.max(0, from + delta))
  if (to === from) return null
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

/** `ids` with the item at `from` moved to `to` (dnd-kit's sortable indexes). */
export function moveIndex(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
