import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { emptyTasks } from '@shared/defaults'
import type { Task, TasksFile } from '@shared/schema'
import { useTasksStore } from '../../../stores/tasks'
import { useUiStore } from '../../../stores/ui'
import { PRIMARY_INFO, seedCanvas } from '../../../test/canvas-fixtures'
import { mockRect } from '../../../test/dnd-rects'
import { createFakeBridge, installFakeBridge } from '../../../test/fake-bridge'
import { DesktopCanvas } from '../../canvas/DesktopCanvas'
import { moveTo, press, release } from '../../dnd/dnd-test-utils'
import { splitTasks } from './task-lists'
import { TodoList } from './TodoList'

function task(id: string, order: number, patch: Partial<Task> = {}): Task {
  return { id, text: id.toUpperCase(), done: false, order, createdAt: 1, ...patch }
}

function Harness(): React.JSX.Element {
  const tasks = useTasksStore((state) => state.tasks)
  return <TodoList tasks={splitTasks(tasks).active} />
}

function setup(tasks: Task[]): { saved(): TasksFile | undefined } {
  const bridge = installFakeBridge(createFakeBridge())
  act(() => useTasksStore.getState().receive({ revision: 1, data: { ...emptyTasks(), tasks } }))
  render(<Harness />)
  return { saved: () => bridge.storage.save.mock.calls.at(-1)?.[1].data as TasksFile }
}

const order = (): string[] => screen.getAllByRole('listitem').map((row) => row.dataset.taskId!)

describe('TodoList', () => {
  it('is a list of the active tasks in `order`', () => {
    setup([task('b', 1), task('a', 0), task('c', 2)])

    expect(screen.getByRole('list', { name: 'Tasks' })).toBeVisible()
    expect(order()).toEqual(['a', 'b', 'c'])
  })

  it('Alt+↓ and Alt+↑ reorder the focused task, update `order` and keep focus on it', async () => {
    const user = userEvent.setup()
    const { saved } = setup([task('a', 0), task('b', 1), task('c', 2)])

    screen.getByRole('listitem', { name: 'A' }).focus()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')

    expect(order()).toEqual(['b', 'a', 'c'])
    expect(screen.getByRole('listitem', { name: 'A' })).toHaveFocus()
    await vi.waitFor(() =>
      expect(saved()?.tasks.map((t) => [t.id, t.order])).toEqual([
        ['b', 0],
        ['a', 1],
        ['c', 2]
      ])
    )
    expect(screen.getByRole('status')).toHaveTextContent('Moved A to position 2 of 3.')

    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(order()).toEqual(['b', 'c', 'a'])
    await user.keyboard('{Alt>}{ArrowUp}{ArrowUp}{/Alt}')
    expect(order()).toEqual(['a', 'b', 'c'])
    expect(screen.getByRole('listitem', { name: 'A' })).toHaveFocus()
  })

  it('does nothing at the ends of the list', async () => {
    const user = userEvent.setup()
    const { saved } = setup([task('a', 0), task('b', 1)])

    screen.getByRole('listitem', { name: 'A' }).focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    screen.getByRole('listitem', { name: 'B' }).focus()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')

    expect(order()).toEqual(['a', 'b'])
    expect(saved()).toBeUndefined()
  })

  it('a pointer drag by the handle reorders inside the canvas DndContext (never an item drag)', async () => {
    installFakeBridge(createFakeBridge())
    seedCanvas()
    act(() =>
      useTasksStore.getState().receive({
        revision: 1,
        data: { ...emptyTasks(), tasks: [task('a', 0), task('b', 1), task('c', 2)] }
      })
    )
    render(
      <main>
        <DesktopCanvas displayId={1} info={PRIMARY_INFO} />
      </main>
    )
    const zone = document.querySelector('[data-canvas-drop]')
    if (zone) mockRect(zone, { width: 2560, height: 1392 })
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      mockRect(screen.getByRole('listitem', { name: id.toUpperCase() }), {
        x: 100,
        y: 100 + index * 36,
        width: 220,
        height: 36
      })
    }
    const handle = screen
      .getByRole('listitem', { name: 'A' })
      .querySelector('[data-drag-handle]') as HTMLElement

    act(() => press(handle, 108, 118))
    act(() => moveTo(108, 130))
    act(() => moveTo(108, 190))
    expect(useUiStore.getState().drag).toBeNull()
    act(() => release(108, 190))

    await vi.waitFor(() =>
      expect(splitTasks(useTasksStore.getState().tasks).active.map((t) => t.id)).toEqual([
        'b',
        'c',
        'a'
      ])
    )
    expect(useUiStore.getState().toasts).toEqual([])
  })

  it('reordering keeps completed tasks after the active ones', async () => {
    const user = userEvent.setup()
    const { saved } = setup([
      task('a', 0),
      task('done', 1, { done: true, completedAt: 1 }),
      task('b', 2)
    ])

    screen.getByRole('listitem', { name: 'B' }).focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')

    await vi.waitFor(() => expect(saved()?.tasks.map((t) => t.id)).toEqual(['b', 'a', 'done']))
  })
})
