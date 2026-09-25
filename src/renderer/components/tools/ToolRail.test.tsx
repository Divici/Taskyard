import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { ToolId } from './tools-geometry'
import { ToolRail } from './ToolRail'

function Harness({
  running = false,
  onChange = () => {}
}: {
  running?: boolean
  onChange?: (tool: ToolId) => void
}): React.JSX.Element {
  const [active, setActive] = useState<ToolId>('tasks')
  return (
    <>
      <ToolRail
        active={active}
        timerRunning={running}
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

describe('ToolRail', () => {
  it('is a vertical tablist with a Tasks and a Timer tab, Tasks selected', async () => {
    const { container } = render(<Harness />)

    const tablist = screen.getByRole('tablist', { name: 'Tools' })
    expect(tablist).toHaveAttribute('aria-orientation', 'vertical')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Tasks', 'Timer'])
    expect(screen.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Timer' })).toHaveAttribute('aria-selected', 'false')
    // Roving tab stop: only the selected tab is in the Tab order.
    expect(screen.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tab', { name: 'Timer' })).toHaveAttribute('tabindex', '-1')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('switches tools with a click', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    await userEvent.click(screen.getByRole('tab', { name: 'Timer' }))

    expect(onChange).toHaveBeenCalledWith('timer')
    expect(screen.getByRole('tab', { name: 'Timer' })).toHaveAttribute('aria-selected', 'true')
  })

  it('arrow keys switch tools and move focus (wrapping); Home and End jump', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const tasks = screen.getByRole('tab', { name: 'Tasks' })
    const timer = screen.getByRole('tab', { name: 'Timer' })
    tasks.focus()

    await user.keyboard('{ArrowDown}')
    expect(timer).toHaveFocus()
    expect(timer).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowDown}')
    expect(tasks).toHaveFocus()
    expect(tasks).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowUp}')
    expect(timer).toHaveFocus()

    await user.keyboard('{Home}')
    expect(tasks).toHaveFocus()
    await user.keyboard('{End}')
    expect(timer).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(tasks).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(timer).toHaveFocus()
  })

  it('shows a glowing badge on the Timer tab while a timer runs', () => {
    const { rerender } = render(<Harness />)
    const timer = screen.getByRole('tab', { name: 'Timer' })
    expect(timer.querySelector('[data-running-badge]')).toBeNull()
    expect(timer).not.toHaveAccessibleDescription()

    rerender(<Harness running />)

    expect(timer.querySelector('[data-running-badge]')).not.toBeNull()
    expect(timer).toHaveAccessibleDescription('Running')
  })
})
