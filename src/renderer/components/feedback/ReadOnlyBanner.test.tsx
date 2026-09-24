import { act, render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { describe, expect, it } from 'vitest'
import { useUiStore } from '../../stores/ui'
import { ReadOnlyBanner } from './ReadOnlyBanner'

describe('ReadOnlyBanner', () => {
  it('renders nothing while every file is writable', () => {
    const { container } = render(<ReadOnlyBanner />)

    expect(container).toBeEmptyDOMElement()
  })

  it('explains that a file from a newer version will not be overwritten', () => {
    render(<ReadOnlyBanner />)

    act(() => {
      useUiStore.getState().setReadOnly([{ store: 'layout', reason: 'future-version', version: 2 }])
    })

    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent('Read-only mode')
    expect(banner).toHaveTextContent(
      'Your desktop layout was saved by a newer version of Taskyard (format v2).'
    )
    expect(banner).toHaveTextContent('Changes you make now won’t be saved.')
  })

  it('lists every read-only file, including ones that could not be read', () => {
    render(<ReadOnlyBanner />)

    act(() => {
      useUiStore.getState().setReadOnly([
        { store: 'settings', reason: 'future-version', version: 3 },
        { store: 'tasks', reason: 'read-error' }
      ])
    })

    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent('Your settings were saved by a newer version')
    expect(banner).toHaveTextContent('Taskyard couldn’t open your tasks and timer')
  })

  it('stays up — it has no dismiss button', () => {
    render(<ReadOnlyBanner />)
    act(() => {
      useUiStore.getState().setReadOnly([{ store: 'layout', reason: 'future-version', version: 2 }])
    })

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('has no detectable accessibility violations', async () => {
    const { container } = render(
      <main>
        <ReadOnlyBanner />
      </main>
    )
    act(() => {
      useUiStore.getState().setReadOnly([{ store: 'layout', reason: 'future-version', version: 2 }])
    })

    expect(await axe(container)).toHaveNoViolations()
  })
})
