import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { describe, expect, it, vi } from 'vitest'
import { useUiStore } from '../../stores/ui'
import { ConfirmDialog, ConfirmHost } from './ConfirmDialog'

function renderDialog(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}): {
  onConfirm: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
} {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <ConfirmDialog
      open
      title="Delete group “Work”?"
      description="Its 3 items go back to the desktop. No files are deleted."
      confirmLabel="Delete group"
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />
  )
  return { onConfirm, onCancel }
}

describe('ConfirmDialog', () => {
  it('shows the title and description in an alert dialog', () => {
    renderDialog()
    const dialog = screen.getByRole('alertdialog', { name: 'Delete group “Work”?' })
    expect(dialog).toHaveAccessibleDescription(
      'Its 3 items go back to the desktop. No files are deleted.'
    )
    expect(dialog).toHaveClass('glass')
  })

  it('confirms with the confirm button', async () => {
    const { onConfirm, onCancel } = renderDialog()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete group' }))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('cancels with Cancel or Esc, and focuses Cancel first for destructive actions', async () => {
    const { onConfirm, onCancel } = renderDialog()
    const user = userEvent.setup()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('renders nothing when closed', () => {
    renderDialog({ open: false })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('has no detectable accessibility violations', async () => {
    renderDialog()
    expect(await axe(document.body)).toHaveNoViolations()
  })

  it('ConfirmHost answers ui.confirm() requests', async () => {
    render(<ConfirmHost />)
    let answer!: Promise<boolean>
    act(() => {
      answer = useUiStore.getState().confirm({
        title: 'Move to the Recycle Bin?',
        description: 'notes.txt',
        confirmLabel: 'Delete'
      })
    })
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Delete' }))
    await expect(answer).resolves.toBe(true)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})
