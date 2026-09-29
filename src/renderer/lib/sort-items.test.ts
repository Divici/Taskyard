import { describe, expect, it } from 'vitest'
import { desktopItem } from '../test/canvas-fixtures'
import { sortLoose } from './sort-items'

const ITEMS = [
  desktopItem('1:1', 'beta', { sizeBytes: 300, mtimeMs: 10 }),
  desktopItem('1:2', 'Alpha', { sizeBytes: 50, mtimeMs: 30, kind: 'app', ext: '.exe' }),
  desktopItem('1:3', 'Zed', { kind: 'folder', sizeBytes: 0, mtimeMs: 20 }),
  desktopItem('1:4', 'gamma', { sizeBytes: 50, mtimeMs: 5 })
]

const names = (key: Parameters<typeof sortLoose>[1]): string[] =>
  sortLoose(ITEMS, key).map((item) => item.name)

describe('sortLoose (Sort by ▸ in the native Desktop menu)', () => {
  it('Name: case-insensitive, like Explorer', () => {
    expect(names('name')).toEqual(['Alpha', 'beta', 'gamma', 'Zed'])
  })

  it('Size: folders first, then smallest first (ties by name)', () => {
    expect(names('size')).toEqual(['Zed', 'Alpha', 'gamma', 'beta'])
  })

  it('Item type: folders, programs, then files', () => {
    expect(names('type')).toEqual(['Zed', 'Alpha', 'beta', 'gamma'])
  })

  it('Date modified: newest first', () => {
    expect(names('modified')).toEqual(['Alpha', 'Zed', 'beta', 'gamma'])
  })

  it('never reorders the input', () => {
    sortLoose(ITEMS, 'size')
    expect(ITEMS.map((item) => item.id)).toEqual(['1:1', '1:2', '1:3', '1:4'])
  })
})
