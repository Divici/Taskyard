import { act, render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { describe, expect, it } from 'vitest'
import type { DesktopItem } from '@shared/schema'
import { GENERIC_ICONS, genericIconUrl } from '../../assets/generic-icons'
import { useItemsStore } from '../../stores/items'
import { LooseItemsGrid } from './LooseItemsGrid'

function item(id: string, name: string, fields: Partial<DesktopItem>): DesktopItem {
  return {
    id,
    path: `C:\\Users\\me\\Desktop\\${name}${fields.ext ?? ''}`,
    name,
    ext: '',
    kind: 'file',
    mtimeMs: 1,
    sizeBytes: 1,
    readonly: false,
    placeholder: false,
    ...fields
  }
}

const ITEMS = [
  item('1:1', 'zeta', { ext: '.txt' }),
  item('1:2', 'Projects', { kind: 'folder' }),
  item('1:3', 'Slack', { kind: 'link', ext: '.lnk', targetPath: 'C:\\slack.exe' }),
  item('1:4', 'Game', { kind: 'url', ext: '.url', url: 'steam://run/1' }),
  item('1:5', 'tool', { kind: 'app', ext: '.exe' }),
  item('1:6', 'cloud', { ext: '.docx', placeholder: true })
]

const tile = (name: string): HTMLElement => screen.getByRole('listitem', { name })
const iconOf = (name: string): HTMLImageElement =>
  within(tile(name)).getByRole('presentation', { hidden: true }) as HTMLImageElement

function renderGrid(items: DesktopItem[] = ITEMS): void {
  useItemsStore.getState().hydrate(items)
  // In a landmark, as App renders it.
  render(
    <main>
      <LooseItemsGrid />
    </main>
  )
}

describe('LooseItemsGrid', () => {
  it('shows one labelled tile per desktop item, sorted by name like Explorer', () => {
    renderGrid()

    const list = screen.getByRole('list', { name: 'Desktop items' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['cloud', 'Game', 'Projects', 'Slack', 'tool', 'zeta'])
  })

  it('shows nothing before the desktop is listed', () => {
    render(<LooseItemsGrid />)
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('draws the built-in icon for the item’s kind until main sends one', () => {
    renderGrid()

    expect(iconOf('Projects').getAttribute('src')).toBe(GENERIC_ICONS.folder)
    expect(iconOf('Slack').getAttribute('src')).toBe(GENERIC_ICONS.link)
    expect(iconOf('Game').getAttribute('src')).toBe(GENERIC_ICONS.url)
    expect(iconOf('tool').getAttribute('src')).toBe(GENERIC_ICONS.app)
    expect(iconOf('zeta').getAttribute('src')).toBe(GENERIC_ICONS.file)
    expect(iconOf('cloud').getAttribute('src')).toBe(genericIconUrl('file'))
    expect(iconOf('zeta')).toHaveAttribute('data-icon', 'generic')
  })

  it('swaps in the icon main streams (desktop:icon), sized 48 CSS px', () => {
    renderGrid()

    act(() => useItemsStore.getState().setIcon('1:3', 96, 'data:image/png;base64,SLACK', 'v1'))

    const icon = iconOf('Slack')
    expect(icon.getAttribute('src')).toBe('data:image/png;base64,SLACK')
    expect(icon).toHaveAttribute('data-icon', '96')
    expect(icon).toHaveAttribute('width', '48')
    expect(icon).toHaveAttribute('height', '48')
  })

  it('marks shortcuts (.lnk and .url) with the shortcut arrow, like Explorer', () => {
    renderGrid()

    expect(tile('Slack').querySelector('[data-shortcut-arrow]')).not.toBeNull()
    expect(tile('Game').querySelector('[data-shortcut-arrow]')).not.toBeNull()
    expect(tile('tool').querySelector('[data-shortcut-arrow]')).toBeNull()
  })

  it('has no detectable accessibility violations', async () => {
    renderGrid()
    expect(await axe(document.body)).toHaveNoViolations()
  })
})
