import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUiStore, type ToastInput } from '../../stores/ui'
import { Toaster } from './Toaster'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function push(input: ToastInput): string {
  let id = ''
  act(() => {
    id = useUiStore.getState().pushToast(input)
  })
  return id
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function setupUser(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
}

describe('Toaster', () => {
  it('shows a toast and auto-dismisses it after its duration', () => {
    render(<Toaster />)

    push({ message: 'Layout restored from backup' })

    expect(screen.getByText('Layout restored from backup')).toBeVisible()
    advance(4_999)
    expect(screen.getByText('Layout restored from backup')).toBeInTheDocument()
    advance(1)
    expect(screen.queryByText('Layout restored from backup')).not.toBeInTheDocument()
    expect(useUiStore.getState().toasts).toEqual([])
  })

  it('announces through a polite status region that exists before any toast', () => {
    render(<Toaster />)
    const live = screen.getByRole('status')

    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(live).toBeEmptyDOMElement()

    push({ message: 'Saved' })

    expect(live).toHaveTextContent('Saved')
    expect(screen.getByRole('region', { name: 'Notifications' })).toContainElement(live)
  })

  it('shows the description under the message', () => {
    render(<Toaster />)

    push({ message: 'Layout reset', description: 'The damaged copy was kept.' })

    expect(screen.getByText('The damaged copy was kept.')).toBeVisible()
  })

  it('removes a toast with its dismiss button', async () => {
    const user = setupUser()
    render(<Toaster />)
    push({ message: 'first' })
    push({ message: 'second' })

    const second = screen.getByText('second').closest('li')!
    await user.click(within(second).getByRole('button', { name: 'Dismiss notification' }))

    expect(screen.queryByText('second')).not.toBeInTheDocument()
    expect(screen.getByText('first')).toBeInTheDocument()
  })

  it('dismisses the focused toast with Escape', async () => {
    const user = setupUser()
    render(<Toaster />)
    push({ message: 'press escape', durationMs: null })

    act(() => screen.getByRole('button', { name: 'Dismiss notification' }).focus())
    await user.keyboard('{Escape}')

    expect(screen.queryByText('press escape')).not.toBeInTheDocument()
  })

  it('keeps a persistent toast until it is dismissed', () => {
    render(<Toaster />)

    push({ message: 'Settings were reset', durationMs: null })
    advance(60_000)

    expect(screen.getByText('Settings were reset')).toBeInTheDocument()
  })

  it('pauses auto-dismiss while hovered and resumes with the time that was left', async () => {
    const user = setupUser()
    render(<Toaster />)
    push({ message: 'hover me' })
    const toast = screen.getByText('hover me').closest('li')!

    advance(3_000)
    await user.hover(toast)
    advance(30_000)
    expect(screen.getByText('hover me')).toBeInTheDocument()

    await user.unhover(toast)
    advance(1_900)
    expect(screen.getByText('hover me')).toBeInTheDocument()
    advance(200)
    expect(screen.queryByText('hover me')).not.toBeInTheDocument()
  })

  it('pauses auto-dismiss while keyboard focus is inside the toast', () => {
    render(<Toaster />)
    push({ message: 'focus me' })

    act(() => screen.getByRole('button', { name: 'Dismiss notification' }).focus())
    advance(30_000)
    expect(screen.getByText('focus me')).toBeInTheDocument()

    act(() => screen.getByRole('button', { name: 'Dismiss notification' }).blur())
    advance(5_000)
    expect(screen.queryByText('focus me')).not.toBeInTheDocument()
  })

  it('runs the action and dismisses the toast', async () => {
    const user = setupUser()
    const onAction = vi.fn()
    render(<Toaster />)
    push({ message: 'Moved 3 files to the desktop', action: { label: 'Undo', onAction } })

    await user.click(screen.getByRole('button', { name: 'Undo' }))

    expect(onAction).toHaveBeenCalledOnce()
    expect(screen.queryByText('Moved 3 files to the desktop')).not.toBeInTheDocument()
  })

  it('restarts the timer when the same toast is pushed again', () => {
    render(<Toaster />)
    push({ id: 'recovered:layout', message: 'first' })
    advance(4_000)

    push({ id: 'recovered:layout', message: 'again' })
    advance(4_000)

    expect(screen.getByText('again')).toBeInTheDocument()
    advance(1_000)
    expect(screen.queryByText('again')).not.toBeInTheDocument()
  })

  it('has no detectable accessibility violations', async () => {
    vi.useRealTimers()
    const { container } = render(<Toaster />)
    push({ message: 'Saved', tone: 'success', action: { label: 'Undo', onAction: vi.fn() } })
    push({ message: 'Failed', tone: 'error', durationMs: null })

    expect(await axe(container)).toHaveNoViolations()
  })
})
