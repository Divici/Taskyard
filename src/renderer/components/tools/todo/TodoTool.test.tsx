import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { emptyTasks } from '@shared/defaults'
import type { Task, TasksFile } from '@shared/schema'
import { useTasksStore } from '../../../stores/tasks'
import { createFakeBridge, installFakeBridge } from '../../../test/fake-bridge'
import { TodoTool } from './TodoTool'

function task(id: string, text: string, patch: Partial<Task> = {}): Task {
  return { id, text, done: false, order: 0, createdAt: 1, ...patch }
}

function setup(tasks: Task[] = []): { saved(): TasksFile; container: HTMLElement } {
  const bridge = installFakeBridge(createFakeBridge())
  act(() => useTasksStore.getState().receive({ revision: 1, data: { ...emptyTasks(), tasks } }))
  const { container } = render(<TodoTool />)
  return {
    container,
    saved: () => bridge.storage.save.mock.calls.at(-1)?.[1].data as TasksFile
  }
}

const activeTexts = (): string[] =>
  within(screen.getByRole('list', { name: 'Tasks' }))
    .queryAllByRole('listitem')
    .map((item) => item.getAttribute('aria-label') ?? '')

describe('TodoTool', () => {
  it('shows the empty state until a task exists', () => {
    setup()

    const empty = screen.getByText('Nothing to do.').closest('[role="status"]')
    expect(empty).toHaveTextContent('Nothing to do.Add a task above.')
  })

  it('Enter adds a task at the bottom and the input keeps focus', async () => {
    const user = userEvent.setup()
    const { saved } = setup([task('a', 'Existing')])
    const input = screen.getByRole('textbox', { name: 'Add a task' })

    await user.click(input)
    await user.keyboard('Buy milk{Enter}')

    expect(activeTexts()).toEqual(['Existing', 'Buy milk'])
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
    await vi.waitFor(() => expect(saved().tasks.map((t) => t.text)).toContain('Buy milk'))
    expect(screen.queryByText('Nothing to do. Add a task above.')).toBeNull()
  })

  it('round 2: the + is a real "Add task" button — disabled while blank, adds, and keeps focus in the field', async () => {
    const user = userEvent.setup()
    const { saved } = setup([task('a', 'Existing')])
    const input = screen.getByRole('textbox', { name: 'Add a task' })
    const add = screen.getByRole('button', { name: 'Add task' })

    expect(input).toHaveAttribute('placeholder', 'Add a task…')
    expect(add).toBeDisabled()
    await user.type(input, '   ')
    expect(add).toBeDisabled()

    await user.clear(input)
    await user.type(input, 'Buy milk')
    expect(add).toBeEnabled()
    await user.click(add)

    expect(activeTexts()).toEqual(['Existing', 'Buy milk'])
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
    expect(add).toBeDisabled()
    await vi.waitFor(() => expect(saved().tasks.map((t) => t.text)).toContain('Buy milk'))
  })

  it('round 2: clicking anywhere on the add row focuses the field', async () => {
    const user = userEvent.setup()
    setup()
    const input = screen.getByRole('textbox', { name: 'Add a task' })
    const row = input.closest('[data-add-row]') as HTMLElement

    await user.click(row)
    expect(input).toHaveFocus()

    // Disabled, the Add button lets presses fall through to the row (checked with a real mouse
    // in e2e/tools.spec.ts: jsdom applies no CSS).
    expect(screen.getByRole('button', { name: 'Add task' })).toHaveClass(
      'disabled:pointer-events-none'
    )
  })

  it('the input is one line of at most 500 characters and ignores blank text', async () => {
    const user = userEvent.setup()
    setup()
    const input = screen.getByRole('textbox', { name: 'Add a task' })

    expect(input).toHaveAttribute('maxLength', '500')
    await user.click(input)
    await user.keyboard('   {Enter}')

    expect(activeTexts()).toEqual([])
  })

  it('double-click edits a task inline; Enter commits', async () => {
    const user = userEvent.setup()
    setup([task('a', 'Water plants')])

    await user.dblClick(screen.getByText('Water plants'))
    const field = screen.getByRole('textbox', { name: 'Edit task Water plants' })
    await user.clear(field)
    await user.keyboard('Water the ferns{Enter}')

    expect(activeTexts()).toEqual(['Water the ferns'])
  })

  it('F2 edits the focused task; Escape cancels', async () => {
    const user = userEvent.setup()
    setup([task('a', 'Water plants')])

    screen.getByRole('listitem', { name: 'Water plants' }).focus()
    await user.keyboard('{F2}')
    await user.keyboard('changed{Escape}')

    expect(activeTexts()).toEqual(['Water plants'])
  })

  it('the × button deletes a task', async () => {
    const user = userEvent.setup()
    setup([task('a', 'One'), task('b', 'Two', { order: 1 })])

    await user.click(screen.getByRole('button', { name: 'Delete One' }))

    expect(activeTexts()).toEqual(['Two'])
  })

  it('checking a task moves it, struck through, into the collapsed Completed section', async () => {
    const user = userEvent.setup()
    setup([task('a', 'One'), task('b', 'Two', { order: 1 })])

    const checkbox = screen.getByRole('checkbox', { name: 'One' })
    expect(checkbox).toHaveAttribute('aria-checked', 'false')
    await user.click(checkbox)

    expect(activeTexts()).toEqual(['Two'])
    const toggle = screen.getByRole('button', { name: 'Completed (1)' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'Completed tasks' })).toBeNull()

    await user.click(toggle)
    const done = within(screen.getByRole('list', { name: 'Completed tasks' }))
    expect(done.getByRole('checkbox', { name: 'One' })).toHaveAttribute('aria-checked', 'true')
    expect(done.getByText('One')).toHaveClass('line-through')
  })

  it('unchecking a completed task returns it to the bottom of the active list', async () => {
    const user = userEvent.setup()
    setup([
      task('a', 'One', { done: true, completedAt: 5 }),
      task('b', 'Two', { order: 1 }),
      task('c', 'Three', { order: 2 })
    ])

    await user.click(screen.getByRole('button', { name: 'Completed (1)' }))
    await user.click(
      within(screen.getByRole('list', { name: 'Completed tasks' })).getByRole('checkbox', {
        name: 'One'
      })
    )

    expect(activeTexts()).toEqual(['Two', 'Three', 'One'])
    expect(screen.queryByRole('button', { name: /Completed/ })).toBeNull()
  })

  it('"Clear completed" removes every done task', async () => {
    const user = userEvent.setup()
    setup([
      task('a', 'One', { done: true, completedAt: 5 }),
      task('b', 'Two', { order: 1 }),
      task('c', 'Three', { order: 2, done: true, completedAt: 6 })
    ])

    await user.click(screen.getByRole('button', { name: 'Clear completed' }))

    expect(activeTexts()).toEqual(['Two'])
    expect(useTasksStore.getState().tasks.map((t) => t.id)).toEqual(['b'])
  })

  it('has no axe violations with active and completed tasks', async () => {
    const user = userEvent.setup()
    const { container } = setup([
      task('a', 'One'),
      task('b', 'Two', { order: 1, done: true, completedAt: 2 })
    ])
    await user.click(screen.getByRole('button', { name: 'Completed (1)' }))

    expect(await axe(container)).toHaveNoViolations()
  })

  it('centred content: the add row stays pinned on top; only the list area scrolls and centres its content', async () => {
    const user = userEvent.setup()
    setup()
    const row = screen.getByRole('textbox', { name: 'Add a task' }).closest('[data-add-row]')!
    const root = row.parentElement!
    const empty = screen.getByText('Nothing to do.').closest('[role="status"]') as HTMLElement

    // The tool fills the tab panel: the add row first, then the list area taking the rest.
    expect(root).toHaveClass('flex', 'flex-col', 'flex-1', 'min-h-0')
    expect(root.firstElementChild).toBe(row)
    const area = root.querySelector('[data-tool-body]') as HTMLElement
    expect(area.parentElement).toBe(root)
    expect(area).not.toContainElement(row as HTMLElement)
    expect(area).toHaveClass('flex', 'flex-col', 'flex-1', 'min-h-0', 'overflow-y-auto')
    // One centred block inside it, the empty state included.
    expect(area.children).toHaveLength(1)
    const content = area.firstElementChild as HTMLElement
    expect(content).toHaveAttribute('data-tool-content')
    expect(content).toHaveClass('my-auto', 'w-full', 'shrink-0')
    expect(content).toContainElement(empty)

    await user.type(screen.getByRole('textbox', { name: 'Add a task' }), 'One{Enter}')
    await user.click(screen.getByRole('checkbox', { name: 'One' }))
    expect(area.children).toHaveLength(1)
    expect(area.firstElementChild).toBe(content)
    expect(content).toContainElement(screen.getByRole('list', { name: 'Tasks' }))
    expect(content).toContainElement(screen.getByRole('button', { name: 'Completed (1)' }))
  })
})
