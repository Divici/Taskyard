import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { desktopItem } from '../../test/canvas-fixtures'
import { DragOverlayPreview } from './DragOverlayPreview'

const ITEMS = ['Notes', 'Plan', 'Budget', 'Code'].map((name, index) =>
  desktopItem(`1:${index + 1}`, name)
)

describe('DragOverlayPreview', () => {
  it('stacks the dragged icons (at most 3) under a count badge for 3 items', () => {
    render(<DragOverlayPreview items={ITEMS.slice(0, 3)} iconSize="medium" showExtension={false} />)

    const preview = document.querySelector('[data-drag-overlay]') as HTMLElement
    expect(preview.querySelectorAll('[data-stack-layer]')).toHaveLength(3)
    expect(screen.getByText('3')).toHaveAttribute('data-count-badge')
    // The grabbed icon is on top and names the stack.
    expect(preview).toHaveTextContent('Notes')
    expect(preview).toHaveAttribute('aria-hidden', 'true')
    // Glass under a moving preview would re-blur every frame: blur is paused on it.
    expect(preview).toHaveAttribute('data-dragging')
  })

  it('shows at most 3 layers for more items, and no badge for one', () => {
    const { rerender } = render(
      <DragOverlayPreview items={ITEMS} iconSize="large" showExtension={false} />
    )
    expect(document.querySelectorAll('[data-stack-layer]')).toHaveLength(3)
    expect(screen.getByText('4')).toHaveAttribute('data-count-badge')

    rerender(<DragOverlayPreview items={ITEMS.slice(0, 1)} iconSize="small" showExtension />)
    expect(document.querySelectorAll('[data-stack-layer]')).toHaveLength(1)
    expect(document.querySelector('[data-count-badge]')).toBeNull()
    expect(screen.getByText('Notes.txt')).toBeInTheDocument()
  })
})
