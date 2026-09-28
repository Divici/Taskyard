import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { ErrorBoundary } from './ErrorBoundary'

function Boom(): React.JSX.Element {
  throw new Error('kaboom')
}

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>desktop</p>
      </ErrorBoundary>
    )
    expect(screen.getByText('desktop')).toBeVisible()
  })

  it('a render error shows a recoverable alert instead of a blank desktop, and logs it', async () => {
    // React reports the caught error on console.error; the boundary logs it once more itself.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onReload = vi.fn()
    const { container } = render(
      <ErrorBoundary onReload={onReload}>
        <Boom />
      </ErrorBoundary>
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Taskyard hit a problem drawing your desktop')
    expect(alert).toHaveTextContent('Your files are safe')
    expect(
      logged.mock.calls.some(
        ([message, error]) =>
          message === 'renderer: the desktop crashed' && (error as Error).message === 'kaboom'
      )
    ).toBe(true)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledOnce()
    expect(await axe(container)).toHaveNoViolations()
  })
})
