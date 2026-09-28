import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { emptyTasks } from '@shared/defaults'
import type { Task } from '@shared/schema'
import { DesktopCanvas } from './components/canvas/DesktopCanvas'
import { ConfirmHost } from './components/feedback/ConfirmDialog'
import { Toaster } from './components/feedback/Toaster'
import { useLayoutStore } from './stores/layout'
import { useTasksStore } from './stores/tasks'
import { desktopItem, makeGroup, PRIMARY_INFO, seedCanvas } from './test/canvas-fixtures'
import { installFakeBridge } from './test/fake-bridge'

// Phase 12 accessibility sweep over the whole canvas: two groups (one with icons, one rolled
// up), loose icons and the tools widget with to-dos.

const ITEMS = [
  desktopItem('1:1', 'Notes'),
  desktopItem('1:2', 'Code', { kind: 'app', ext: '.exe' }),
  desktopItem('1:3', 'Projects', { kind: 'folder' }),
  desktopItem('1:4', 'Docs', { kind: 'url', ext: '.url' })
]

const task = (id: string, text: string, order: number, done = false): Task => ({
  id,
  text,
  done,
  order,
  createdAt: order,
  ...(done ? { completedAt: 10 } : {})
})

function renderDesktop(): ReturnType<typeof userEvent.setup> {
  installFakeBridge()
  seedCanvas({
    items: ITEMS,
    loose: { '1:4': { x: 0, y: 0 } },
    groups: [
      makeGroup('work', { title: 'Work', x: 400, y: 40, z: 1, items: ['1:1', '1:2'] }),
      makeGroup('later', { title: 'Later', x: 800, y: 40, z: 2, items: ['1:3'], rolledUp: true })
    ]
  })
  act(() => {
    useLayoutStore
      .getState()
      .updateTools(PRIMARY_INFO.id, (tools) => ({ ...tools, x: 1600, y: 40, visible: true }))
    useTasksStore.getState().receive({
      revision: 1,
      data: {
        ...emptyTasks(),
        tasks: [task('t1', 'Write report', 0), task('t2', 'Call Sam', 1, true)]
      }
    })
  })
  render(
    <main>
      <DesktopCanvas displayId={PRIMARY_INFO.id} info={PRIMARY_INFO} />
      <ConfirmHost />
      <Toaster />
    </main>
  )
  return userEvent.setup()
}

/** Tabs through the page (up to `limit` stops) and returns every element that took the focus. */
async function tabWalk(user: ReturnType<typeof userEvent.setup>, limit = 60): Promise<Element[]> {
  const seen: Element[] = []
  for (let i = 0; i < limit; i++) {
    await user.tab()
    const focused = document.activeElement
    if (!focused || focused === document.body || seen.includes(focused)) break
    seen.push(focused)
  }
  return seen
}

const INTERACTIVE =
  'button, input, select, textarea, a[href], [role="tab"], [role="option"], [role="switch"], [role="checkbox"], [role="menuitem"]'

describe('accessibility (Phase 12)', () => {
  it('the canvas with two groups and the to-do widget has no axe violations', async () => {
    renderDesktop()
    expect(screen.getByRole('region', { name: 'Work' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Tools' })).toBeInTheDocument()
    expect(await axe(document.body)).toHaveNoViolations()
  })

  it('every interactive element is reachable with Tab (roving lists: one stop each)', async () => {
    const user = renderDesktop()
    const reached = await tabWalk(user)

    // The desktop itself, so its menu has a keyboard route.
    expect(reached).toContain(screen.getByRole('application', { name: 'Desktop' }))
    for (const element of document.querySelectorAll<HTMLElement>(INTERACTIVE)) {
      if (element.closest('[inert]') || (element as HTMLButtonElement).disabled) continue
      const roving = element.closest('[role="listbox"], [role="tablist"]')
      if (roving) {
        // Arrow keys move inside; Tab reaches the list once.
        const stops = Array.from(roving.querySelectorAll<HTMLElement>('[tabindex="0"]'))
        expect(stops, roving.getAttribute('aria-label') ?? '').toHaveLength(1)
        expect(reached).toContain(stops[0])
        continue
      }
      expect(reached, element.outerHTML.slice(0, 120)).toContain(element)
    }
  })

  it('every Tab stop shows a visible focus indicator', async () => {
    const user = renderDesktop()
    for (const element of await tabWalk(user)) {
      // Each stop carries a focus-visible (or focus) ring/outline utility — or, for a bare text
      // field inside a styled box, its box shows a focus-within ring: never a bare outline-none.
      const own = element.getAttribute('class') ?? ''
      const box = element.parentElement?.getAttribute('class') ?? ''
      const indicated = /focus-visible:|focus:/.test(own) || /focus-within:/.test(box)
      expect(indicated, element.outerHTML.slice(0, 120)).toBe(true)
    }
  })

  it.each([
    ['Shift+F10', '{Shift>}{F10}{/Shift}'],
    ['the menu key', '{ContextMenu}']
  ])('%s opens the menu of whatever has the focus', async (_name, keys) => {
    const user = renderDesktop()

    // The desktop: its canvas menu.
    act(() => screen.getByRole('application', { name: 'Desktop' }).focus())
    await user.keyboard(keys)
    expect(await screen.findByRole('menuitem', { name: 'New group here' })).toBeVisible()
    await user.keyboard('{Escape}')

    // A group's title bar control: that group's menu.
    const work = screen.getByRole('region', { name: 'Work' })
    act(() => within(work).getByRole('button', { name: 'Roll up' }).focus())
    await user.keyboard(keys)
    const groupMenu = await screen.findByRole('menu')
    expect(within(groupMenu).getByRole('menuitem', { name: /^Rename/ })).toBeVisible()
    expect(within(groupMenu).getByRole('menuitem', { name: 'Roll up' })).toBeVisible()
    await user.keyboard('{Escape}')

    // The tools widget: its menu.
    const tools = screen.getByRole('region', { name: 'Tools' })
    act(() => within(tools).getByRole('button', { name: 'Roll up' }).focus())
    await user.keyboard(keys)
    expect(await screen.findByRole('menuitem', { name: 'Hide tools widget' })).toBeVisible()
  })

  it('a focused icon keeps its own menu (the group menu does not open over it)', async () => {
    const user = renderDesktop()
    const work = screen.getByRole('region', { name: 'Work' })
    const notes = within(work).getByRole('option', { name: 'Notes' })
    await user.click(notes)
    await user.keyboard('{Shift>}{F10}{/Shift}')
    const menus = await screen.findAllByRole('menu')
    expect(menus).toHaveLength(1)
    expect(within(menus[0]).getByRole('menuitem', { name: 'Open file location' })).toBeVisible()
    expect(within(menus[0]).queryByRole('menuitem', { name: 'Roll up' })).toBeNull()
  })

  it('the desktop surface is not a trap: its menu is also reachable from a pointer', () => {
    renderDesktop()
    fireEvent.contextMenu(screen.getByRole('application', { name: 'Desktop' }), {
      clientX: 700,
      clientY: 500
    })
    expect(screen.getByRole('menuitem', { name: 'New group here' })).toBeVisible()
  })
})
