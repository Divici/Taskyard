import { useMemo } from 'react'
import { useTasksStore } from '../../../stores/tasks'
import { CompletedSection } from './CompletedSection'
import { splitTasks } from './task-lists'
import { TodoInput } from './TodoInput'
import { TodoList } from './TodoList'

/**
 * The to-do tool: the "Add a task" field, the active tasks (a sortable list) and the collapsed
 * Completed section. Everything is tasks.json through the tasks store.
 */
export function TodoTool(): React.JSX.Element {
  const tasks = useTasksStore((state) => state.tasks)
  const { active, completed } = useMemo(() => splitTasks(tasks), [tasks])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <TodoInput onAdd={(text) => useTasksStore.getState().add(text) !== null} />
      <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-width:thin]">
        {active.length === 0 && (
          <p className="px-2 py-3 text-[12px] text-text-tertiary">
            Nothing to do. Add a task above.
          </p>
        )}
        <TodoList tasks={active} />
        <CompletedSection tasks={completed} />
      </div>
    </div>
  )
}
