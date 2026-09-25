import { describe, expect, it } from 'vitest'
import { mockRect } from '../../test/dnd-rects'
import { gridInsertIndex, groupBodyGrid, resolveGroupDrop } from './group-drop'

// A 3-column grid of 80 × 80 cells with 8 px padding, at (100, 50): cells start at x 108,
// 188, 268 and y 58, 138, …
const GRID = {
  left: 100,
  top: 50,
  width: 256,
  padding: 8,
  columns: 3,
  cellHeight: 80,
  scrollTop: 0,
  count: 5
}

describe('gridInsertIndex', () => {
  it('is the index before the cell under the point, or after it past the cell’s middle', () => {
    expect(gridInsertIndex({ x: 110, y: 60 }, GRID)).toBe(0)
    expect(gridInsertIndex({ x: 240, y: 60 }, GRID)).toBe(2) // right half of cell 1
    expect(gridInsertIndex({ x: 200, y: 150 }, GRID)).toBe(4) // left half of row 1, column 1
  })

  it('counts rows scrolled out of view and clamps to [0, count]', () => {
    expect(gridInsertIndex({ x: 110, y: 60 }, { ...GRID, scrollTop: 80 })).toBe(3)
    expect(gridInsertIndex({ x: 350, y: 600 }, GRID)).toBe(5)
    expect(gridInsertIndex({ x: 0, y: 0 }, GRID)).toBe(0)
  })
})

function body(ids: string[], columns = 3): HTMLElement {
  const element = document.createElement('div')
  element.dataset.groupBody = 'g'
  element.dataset.columns = String(columns)
  element.dataset.cellHeight = '80'
  for (const id of ids) {
    const option = document.createElement('div')
    option.dataset.itemId = id
    element.append(option)
  }
  document.body.append(element)
  mockRect(element, { x: 100, y: 50, width: 256, height: 200 })
  return element
}

describe('groupBodyGrid / resolveGroupDrop', () => {
  it('reads the grid from the rendered group body', () => {
    expect(groupBodyGrid(body(['1:1', '1:2']))).toEqual({ ...GRID, count: 2 })
  })

  it('manual sort: the index under the point and the item it lands before', () => {
    const element = body(['1:1', '1:2', '1:3', '1:4'])

    expect(resolveGroupDrop(element, { x: 200, y: 60 }, 'manual')).toEqual({
      index: 1,
      beforeId: '1:2'
    })
    expect(resolveGroupDrop(element, { x: 340, y: 150 }, 'manual')).toEqual({
      index: 4,
      beforeId: null
    })
  })

  it('other sorts and rolled-up groups (no body) append: the group re-sorts itself', () => {
    expect(resolveGroupDrop(body(['1:1']), { x: 110, y: 60 }, 'name')).toEqual({
      index: null,
      beforeId: null
    })
    expect(resolveGroupDrop(null, { x: 110, y: 60 }, 'manual')).toEqual({
      index: null,
      beforeId: null
    })
  })
})
