import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopItem } from '@shared/schema'
import { desktopItem } from '../../test/canvas-fixtures'
import { DesktopIcon } from './DesktopIcon'
import { displayName } from './item-label'

function renderIcon(
  item: DesktopItem,
  props: Partial<React.ComponentProps<typeof DesktopIcon>> = {}
): HTMLElement {
  // In a landmark, as the canvas renders it.
  render(
    <main>
      <div role="listbox" aria-label="Desktop">
        <DesktopIcon
          item={item}
          variant="group"
          iconSize="medium"
          showExtension={false}
          selected={false}
          tabbable
          {...props}
        />
      </div>
    </main>
  )
  return screen.getByRole('option')
}

describe('displayName', () => {
  it('adds the extension only when asked, and never for shortcuts or folders', () => {
    const file = desktopItem('1:1', 'Budget', { ext: '.xlsx' })
    expect(displayName(file, false)).toBe('Budget')
    expect(displayName(file, true)).toBe('Budget.xlsx')
    expect(displayName(desktopItem('1:2', 'Slack', { kind: 'link', ext: '.lnk' }), true)).toBe(
      'Slack'
    )
    expect(displayName(desktopItem('1:3', 'Site', { kind: 'url', ext: '.url' }), true)).toBe('Site')
    expect(displayName(desktopItem('1:4', 'Projects', { kind: 'folder' }), true)).toBe('Projects')
  })
})

describe('DesktopIcon', () => {
  it('is an option named by its label, with the full path as a tooltip', () => {
    const item = desktopItem('1:1', 'Budget', { ext: '.xlsx' })
    const option = renderIcon(item)
    expect(option).toHaveAccessibleName('Budget')
    expect(option).toHaveAttribute('title', item.path)
    expect(option).toHaveAttribute('data-item-id', '1:1')
  })

  it('shows the extension when the setting is on', () => {
    renderIcon(desktopItem('1:1', 'Budget', { ext: '.xlsx' }), { showExtension: true })
    expect(screen.getByRole('option')).toHaveAccessibleName('Budget.xlsx')
  })

  it('reflects selection with aria-selected and is tabbable only when asked (roving focus)', () => {
    const { rerender } = render(
      <div role="listbox" aria-label="Desktop">
        <DesktopIcon
          item={desktopItem('1:1', 'a')}
          variant="loose"
          iconSize="medium"
          showExtension={false}
          selected
          tabbable={false}
        />
      </div>
    )
    const option = screen.getByRole('option')
    expect(option).toHaveAttribute('aria-selected', 'true')
    expect(option).toHaveAttribute('tabindex', '-1')
    rerender(
      <div role="listbox" aria-label="Desktop">
        <DesktopIcon
          item={desktopItem('1:1', 'a')}
          variant="loose"
          iconSize="medium"
          showExtension={false}
          selected={false}
          tabbable
        />
      </div>
    )
    expect(option).toHaveAttribute('aria-selected', 'false')
    expect(option).toHaveAttribute('tabindex', '0')
  })

  it('ellipsizes long labels: one line in a group, two lines loose', () => {
    const long = desktopItem('1:1', 'A very long file name that never fits under an icon')
    renderIcon(long)
    const label = within(screen.getByRole('option')).getByText(long.name)
    expect(label).toHaveClass('truncate')
    expect(label).toHaveAttribute('title', long.name)
  })

  it('wraps a loose label to two lines before the ellipsis', () => {
    render(
      <div role="listbox" aria-label="Desktop">
        <DesktopIcon
          item={desktopItem('1:1', 'A long loose name')}
          variant="loose"
          iconSize="large"
          showExtension={false}
          selected={false}
          tabbable
        />
      </div>
    )
    expect(screen.getByText('A long loose name')).toHaveClass('line-clamp-2')
  })

  it('shows the read-only and online-only badges and the shortcut arrow', () => {
    renderIcon(desktopItem('1:1', 'Public', { readonly: true, placeholder: true }))
    const option = screen.getByRole('option')
    expect(option.querySelector('[data-badge="readonly"]')).toHaveAttribute(
      'title',
      'Read-only: Windows won’t let you rename or delete this item'
    )
    expect(option.querySelector('[data-badge="placeholder"]')).toHaveAttribute(
      'title',
      'Online-only: stored in the cloud until you open it'
    )
    expect(option.querySelector('[data-shortcut-arrow]')).toBeNull()
  })

  it('marks shortcuts with the shortcut arrow and plain items with no badges', () => {
    renderIcon(desktopItem('1:1', 'Slack', { kind: 'link', ext: '.lnk' }))
    const option = screen.getByRole('option')
    expect(option.querySelector('[data-shortcut-arrow]')).not.toBeNull()
    expect(option.querySelector('[data-badge]')).toBeNull()
  })

  it('draws the glyph at the icon size: 40 px in a group, 48 px loose (medium)', () => {
    renderIcon(desktopItem('1:1', 'a'), { iconSize: 'large' })
    expect(screen.getByRole('option').querySelector('img')).toHaveAttribute('width', '48')
    cleanup()
    renderIcon(desktopItem('1:1', 'a'), { iconSize: 'medium' })
    expect(screen.getByRole('option').querySelector('img')).toHaveAttribute('width', '40')
    cleanup()
    renderIcon(desktopItem('1:1', 'a'), { iconSize: 'medium', variant: 'loose' })
    expect(screen.getByRole('option').querySelector('img')).toHaveAttribute('width', '48')
  })

  it('selects on click (with the modifiers) and opens on double-click', async () => {
    const onSelect = vi.fn()
    const onOpen = vi.fn()
    const option = renderIcon(desktopItem('1:1', 'a'), { onSelect, onOpen })
    const user = userEvent.setup()

    await user.click(option)
    await user.keyboard('{Control>}')
    await user.click(option)
    await user.keyboard('{/Control}')
    expect(onSelect).toHaveBeenCalledTimes(2)
    expect(onSelect.mock.calls[1][0]).toMatchObject({ ctrlKey: true })

    await user.dblClick(option)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('swaps the label for the inline rename field while renaming', async () => {
    const onRenameCommit = vi.fn()
    renderIcon(desktopItem('1:1', 'notes'), { renaming: true, onRenameCommit })
    expect(screen.getByRole('textbox', { name: 'Rename notes' })).toHaveFocus()
    await userEvent.setup().keyboard('todo{Enter}')
    expect(onRenameCommit).toHaveBeenCalledWith('todo')
  })

  it('has no detectable accessibility violations', async () => {
    renderIcon(desktopItem('1:1', 'a', { readonly: true }), { selected: true })
    expect(await axe(document.body)).toHaveNoViolations()
  })
})
