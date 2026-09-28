import { render, screen } from '@testing-library/react'
import { Inbox } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('shows a title, an optional hint and a decorative icon as a polite status', async () => {
    const { container } = render(
      <EmptyState icon={Inbox} title="No tasks yet" hint="Add one above." />
    )
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('No tasks yet')
    expect(status).toHaveTextContent('Add one above.')
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('without a hint it is just the title', () => {
    render(<EmptyState title="Drop icons here" />)
    expect(screen.getByRole('status')).toHaveTextContent(/^Drop icons here$/)
  })
})
