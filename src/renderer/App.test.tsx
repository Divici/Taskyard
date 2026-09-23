import { render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App', () => {
  it('renders the Taskyard placeholder inside a main landmark', () => {
    render(<App />)

    const main = screen.getByRole('main')
    expect(main).toContainElement(screen.getByRole('heading', { level: 1, name: 'Taskyard' }))
  })

  it('has no detectable accessibility violations', async () => {
    const { container } = render(<App />)

    expect(await axe(container)).toHaveNoViolations()
  })
})
