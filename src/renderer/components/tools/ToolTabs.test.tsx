import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { ToolId } from './tools-geometry'
import { ToolTabs } from './ToolTabs'

function Harness({
  running = {},
  onChange = () => {}
}: {
  running?: Partial<Record<ToolId, boolean>>
  onChange?: (tool: ToolId) => void
}): React.JSX.Element {
  const [active, setActive] = useState<ToolId>('tasks')
  return (
    <>
      <ToolTabs
        active={active}
        running={running}
        idPrefix="tools-1"
        onChange={(tool) => {
          setActive(tool)
          onChange(tool)
        }}
      />
      <div role="tabpanel" id="tools-1-panel" aria-labelledby={`tools-1-tab-${active}`}>
        panel
      </div>
    </>
  )
}

describe('ToolTabs', () => {
  it('is a horizontal, centred segmented tablist: Tasks · Timer · Stopwatch, Tasks selected', async () => {
    const { container } = render(<Harness />)

    const tablist = screen.getByRole('tablist', { name: 'Tools' })
    expect(tablist).toHaveAttribute('aria-orientation', 'horizontal')
    expect(tablist).toHaveClass('mx-auto')
    const tabs = screen.getAllByRole('tab')
    // Each segment shows its name as text (not only an icon).
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Tasks', 'Timer', 'Stopwatch'])
    expect(screen.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Timer' })).toHaveAttribute('aria-selected', 'false')
    // Roving tab stop: only the selected tab is in the Tab order.
    expect(screen.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tab', { name: 'Timer' })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('tab', { name: 'Stopwatch' })).toHaveAttribute('tabindex', '-1')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('switches tools with a click', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await userEvent.click(screen.getByRole('tab', { name: 'Stopwatch' }))

    expect(onChange).toHaveBeenCalledWith('stopwatch')
    expect(screen.getByRole('tab', { name: 'Stopwatch' })).toHaveAttribute('aria-selected', 'true')
  })

  it('arrow keys switch tools and move focus (wrapping); Home and End jump', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const tasks = screen.getByRole('tab', { name: 'Tasks' })
    const timer = screen.getByRole('tab', { name: 'Timer' })
    const stopwatch = screen.getByRole('tab', { name: 'Stopwatch' })
    tasks.focus()

    await user.keyboard('{ArrowRight}')
    expect(timer).toHaveFocus()
    expect(timer).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowRight}')
    expect(stopwatch).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(tasks).toHaveFocus()
    expect(tasks).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowLeft}')
    expect(stopwatch).toHaveFocus()

    await user.keyboard('{Home}')
    expect(tasks).toHaveFocus()
    await user.keyboard('{End}')
    expect(stopwatch).toHaveFocus()
  })

  it('shows a glowing dot on the Timer and Stopwatch tabs while each runs', () => {
    const { rerender } = render(<Harness />)
    const timer = screen.getByRole('tab', { name: 'Timer' })
    const stopwatch = screen.getByRole('tab', { name: 'Stopwatch' })
    expect(timer.querySelector('[data-running-badge]')).toBeNull()
    expect(timer).not.toHaveAccessibleDescription()

    rerender(<Harness running={{ timer: true }} />)
    expect(timer.querySelector('[data-running-badge]')).not.toBeNull()
    expect(timer).toHaveAccessibleDescription('Running')
    expect(stopwatch.querySelector('[data-running-badge]')).toBeNull()

    rerender(<Harness running={{ stopwatch: true }} />)
    expect(timer.querySelector('[data-running-badge]')).toBeNull()
    expect(stopwatch.querySelector('[data-running-badge]')).not.toBeNull()
    expect(stopwatch).toHaveAccessibleDescription('Running')
  })

  it('the running dot sits in the tab corner, out of the text flow, and the tab holds only its name', () => {
    render(<Harness running={{ stopwatch: true }} />)
    const stopwatch = screen.getByRole('tab', { name: 'Stopwatch' })
    const badge = stopwatch.querySelector('[data-running-badge]')!

    expect(stopwatch).toHaveClass('relative')
    expect(badge).toHaveClass('absolute')
    // No icons or other flow content beside the centred label (the widths are checked for real
    // at the 280 px minimum in e2e/tools.spec.ts).
    expect(stopwatch.querySelector('svg')).toBeNull()
    const inFlow = [...stopwatch.children].filter(
      (child) => !child.classList.contains('absolute') && !child.classList.contains('sr-only')
    )
    expect(inFlow.map((child) => child.textContent)).toEqual(['Stopwatch'])
  })
})
