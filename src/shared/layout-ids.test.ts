import { describe, expect, it } from 'vitest'
import { newDisplayLayout } from './defaults'
import { forgetItemIds } from './layout-ids'
import type { Group, LayoutFile } from './schema'

function group(id: string, items: string[]): Group {
  return {
    id,
    title: id,
    x: 0,
    y: 0,
    w: 280,
    h: 200,
    z: 0,
    rolledUp: false,
    items,
    sort: 'manual',
    excludeFromQuickHide: false,
    createdAt: 0
  }
}

function layout(): LayoutFile {
  const primary = newDisplayLayout(1, { x: 0, y: 0, width: 2560, height: 1440 })
  const secondary = newDisplayLayout(2, { x: 2560, y: 0, width: 1920, height: 1080 })
  return {
    version: 1,
    displays: [
      { ...primary, groups: [group('a', ['1:1', '1:2']), group('b', ['1:3'])] },
      { ...secondary, loose: { '1:2': { x: 8, y: 8 }, '1:4': { x: 96, y: 8 } } }
    ],
    paths: { '1:1': 'C:\\a', '1:2': 'C:\\b', '1:3': 'C:\\c', '1:4': 'C:\\d' },
    lastSeen: { '1:2': 5, '1:4': 6 }
  }
}

describe('forgetItemIds', () => {
  it('removes the ids from every group, the loose layer, paths and lastSeen', () => {
    const result = forgetItemIds(layout(), ['1:2', '1:3'])

    expect(result.displays[0].groups.map((g) => g.items)).toEqual([['1:1'], []])
    expect(result.displays[1].loose).toEqual({ '1:4': { x: 96, y: 8 } })
    expect(result.paths).toEqual({ '1:1': 'C:\\a', '1:4': 'C:\\d' })
    expect(result.lastSeen).toEqual({ '1:4': 6 })
  })

  it('does not mutate its input', () => {
    const input = layout()
    const snapshot = structuredClone(input)

    forgetItemIds(input, ['1:1', '1:2', '1:3', '1:4'])

    expect(input).toEqual(snapshot)
  })

  it('returns the same layout when none of the ids are placed', () => {
    const input = layout()

    expect(forgetItemIds(input, ['9:9'])).toBe(input)
    expect(forgetItemIds(input, [])).toBe(input)
  })
})
