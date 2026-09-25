import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { INVALID_NAME_HINT, RenameInline } from './RenameInline'

function setup(props: Partial<React.ComponentProps<typeof RenameInline>> = {}): {
  input: HTMLInputElement
  onCommit: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
  user: ReturnType<typeof userEvent.setup>
} {
  const onCommit = vi.fn()
  const onCancel = vi.fn()
  render(
    <RenameInline
      value="Budget"
      label="Rename Budget"
      onCommit={onCommit}
      onCancel={onCancel}
      {...props}
    />
  )
  return {
    input: screen.getByRole('textbox', { name: 'Rename Budget' }) as HTMLInputElement,
    onCommit,
    onCancel,
    user: userEvent.setup()
  }
}

describe('RenameInline', () => {
  it('opens focused with the whole name selected', () => {
    const { input } = setup()
    expect(input).toHaveFocus()
    expect(input.value).toBe('Budget')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6])
  })

  it('Enter commits the new name (trimmed)', async () => {
    const { input, onCommit, onCancel, user } = setup()
    await user.clear(input)
    await user.type(input, '  Budget 2026 {Enter}')
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Budget 2026')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Esc cancels and does not let the key reach the list around it', async () => {
    const onKeyDown = vi.fn()
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(
      <div onKeyDown={onKeyDown}>
        <RenameInline value="a" label="Rename a" onCommit={onCommit} onCancel={onCancel} />
      </div>
    )
    const user = userEvent.setup()
    await user.type(screen.getByRole('textbox'), 'bc{Escape}')
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onCommit).not.toHaveBeenCalled()
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it('an empty or unchanged name reverts instead of committing', async () => {
    const { input, onCommit, onCancel, user } = setup()
    await user.clear(input)
    await user.type(input, '   {Enter}')
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('leaving the field (blur) commits, like Explorer', async () => {
    const { onCommit, user } = setup()
    // Typing replaces the selected name.
    await user.keyboard('X')
    await user.tab()
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('X')
  })

  it('blocks the characters Windows forbids in file names and says why', async () => {
    const { input, user } = setup()
    await user.clear(input)
    await user.type(input, 'a<b>:c"d/e\\f|g?h*i')
    expect(input.value).toBe('abcdefghi')
    expect(screen.getByRole('status')).toHaveTextContent(INVALID_NAME_HINT)
  })

  it('allows those characters when blocking is off (group titles)', async () => {
    const { input, user } = setup({ blockInvalidChars: false })
    await user.clear(input)
    await user.type(input, 'Q&A: 2026?')
    expect(input.value).toBe('Q&A: 2026?')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('caps the name at 255 characters', async () => {
    const { input, user } = setup()
    await user.clear(input)
    await user.click(input)
    await user.paste('x'.repeat(300))
    expect(input.value).toHaveLength(255)
  })

  it('is disabled for read-only items and never commits', async () => {
    const { input, onCommit, user } = setup({ readOnly: true })
    expect(input).toBeDisabled()
    await user.type(input, 'x{Enter}')
    expect(onCommit).not.toHaveBeenCalled()
  })
})
