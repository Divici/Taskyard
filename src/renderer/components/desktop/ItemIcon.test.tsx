import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useItemsStore } from '../../stores/items'
import { ItemIcon } from './ItemIcon'

const ITEM = { id: '1:1', kind: 'app' } as const
const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('ItemIcon', () => {
  it('shows a skeleton tile while the first icons are still loading', () => {
    const { container } = render(<ItemIcon item={ITEM} />)
    const skeleton = container.querySelector('[data-icon="skeleton"]')
    expect(skeleton).toHaveAttribute('aria-hidden', 'true')
    expect(skeleton).toHaveStyle({ width: '48px', height: '48px' })
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('the icon replaces the skeleton as soon as it arrives', () => {
    const { container } = render(<ItemIcon item={ITEM} />)
    act(() => useItemsStore.getState().setIcon('1:1', 96, PNG, 'v1'))
    expect(container.querySelector('[data-icon="skeleton"]')).toBeNull()
    expect(container.querySelector('img')).toHaveAttribute('data-icon', '96')
  })

  it('once the icon pass is over, an item without an icon shows the generic one', () => {
    const { container } = render(<ItemIcon item={ITEM} />)
    act(() => useItemsStore.getState().setIconsLoaded())
    expect(container.querySelector('img')).toHaveAttribute('data-icon', 'generic')
  })
})
