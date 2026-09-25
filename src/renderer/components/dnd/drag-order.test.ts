import { describe, expect, it } from 'vitest'
import { desktopItem, makeGroup } from '../../test/canvas-fixtures'
import { dragOrder } from './drag-order'

const byId = Object.fromEntries(
  [
    desktopItem('1:1', 'Zebra'),
    desktopItem('1:2', 'Apple'),
    desktopItem('1:3', 'Mango'),
    desktopItem('1:4', 'Loose top'),
    desktopItem('1:5', 'Loose right')
  ].map((item) => [item.id, item])
)

describe('dragOrder', () => {
  it('orders a selection as it is shown: groups by stacking order, each in its display order, then loose column-first', () => {
    const display = {
      groups: [
        makeGroup('top', { z: 5, items: ['1:3'] }),
        makeGroup('under', { z: 1, items: ['1:1', '1:2'], sort: 'name' })
      ],
      loose: { '1:5': { x: 96, y: 0 }, '1:4': { x: 0, y: 96 } }
    }

    expect(dragOrder(['1:5', '1:3', '1:1', '1:4', '1:2'], display, byId)).toEqual([
      '1:2', // "under" sorts by name: Apple, Zebra
      '1:1',
      '1:3',
      '1:4',
      '1:5'
    ])
  })

  it('keeps ids the display does not place at the end, in selection order', () => {
    expect(
      dragOrder(['9:9', '1:4'], { groups: [], loose: { '1:4': { x: 0, y: 0 } } }, byId)
    ).toEqual(['1:4', '9:9'])
  })
})
