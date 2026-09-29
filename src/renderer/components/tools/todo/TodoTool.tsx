import { ListTodo } from 'lucide-react'
import { useMemo } from 'react'
import { cn } from '../../../lib/utils'
import { useTasksStore } from '../../../stores/tasks'
import { EmptyState } from '../../feedback/EmptyState'
import { TOOL_BODY, TOOL_CENTRED } from '../tool-styles'
import { CompletedSection } from './CompletedSection'
import { splitTasks } from './task-lists'
import { TodoInput } from './TodoInput'
import { TodoList } from './TodoList'

/**
 * The to-do tool: the "Add a task" field pinned on top, then the list area filling the rest —
 * the active tasks (a sortable list) and the collapsed Completed section, centred in that area
 * while they are shorter than it and scrolling from the top once taller (2026-09-29). Everything
 * is tasks.json through the tasks store.
 */
export function TodoTool(): React.JSX.Element {
  const tasks = useTasksStore((state) => state.tasks)
  const { active, completed } = useMemo(() => splitTasks(tasks), [tasks])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <TodoInput onAdd={(text) => useTasksStore.getState().add(text) !== null} />
      <div data-tool-body="" className={cn(TOOL_BODY, '-mr-1 pr-1')}>
        <div data-tool-content="" className={TOOL_CENTRED}>
          {active.length === 0 && (
            <EmptyState
              icon={ListTodo}
              title="Nothing to do."
              hint="Add a task above."
              className="py-6"
            />
          )}
          <TodoList tasks={active} />
          <CompletedSection tasks={completed} />
        </div>
      </div>
    </div>
  )
}
