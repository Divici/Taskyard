import { describe, expect, it } from 'vitest'
import { AUTO_ORGANIZE_TITLES, autoOrganize, type OrganizableItem } from './auto-organize'
import { emptyLayout, newDisplayLayout } from './defaults'
import { GROUP_HEADER_HEIGHT } from './group-metrics'
import { applyAutoOrganize } from './layout-mutations'
import type { Group, LayoutFile } from './schema'

const AREA = { x: 0, y: 0, width: 1920, height: 1032 }
const CELL = { width: 80, height: 80 }
let counter = 0
const OPTIONS = { area: AREA, cell: CELL, now: 42, newId: () => `g${++counter}` }

const it_ = (id: string, name: string, kind: OrganizableItem['kind']): OrganizableItem => ({
  id,
  name,
  kind
})

describe('autoOrganize', () => {
  it('makes one group per kind in a 2×2 grid: Apps, Files, Folders, Web links', () => {
    counter = 0
    const groups = autoOrganize(
      [
        it_('1', 'Zoom', 'link'),
        it_('2', 'notes', 'file'),
        it_('3', 'Code', 'app'),
        it_('4', 'Projects', 'folder'),
        it_('5', 'Docs site', 'url')
      ],
      OPTIONS
    )

    expect(groups.map((g) => g.title)).toEqual(['Apps', 'Files', 'Folders', 'Web links'])
    expect(AUTO_ORGANIZE_TITLES).toEqual(['Apps', 'Files', 'Folders', 'Web links'])
    // Items sorted by name inside each group.
    expect(groups[0].items).toEqual(['3', '1'])
    expect(groups.map((g) => [g.x, g.y])).toEqual([
      [24, 24],
      [24 + groups[0].w + 24, 24],
      [24, groups[2].y],
      [24 + groups[0].w + 24, groups[2].y]
    ])
    expect(groups[2].y).toBeGreaterThan(24 + GROUP_HEADER_HEIGHT)
    for (const g of groups) {
      expect(g).toMatchObject({ rolledUp: false, sort: 'name', createdAt: 42 })
      expect(g.x + g.w).toBeLessThanOrEqual(AREA.width)
      expect(g.y + g.h).toBeLessThanOrEqual(AREA.height)
    }
    expect(new Set(groups.map((g) => g.id)).size).toBe(4)
  })

  it('skips empty categories and packs the rest into the grid in order', () => {
    const groups = autoOrganize([it_('1', 'a', 'folder'), it_('2', 'b', 'url')], OPTIONS)
    expect(groups.map((g) => g.title)).toEqual(['Folders', 'Web links'])
    expect(groups[0]).toMatchObject({ x: 24, y: 24 })
    expect(groups[1].y).toBe(24)
  })

  it('returns no groups for no items', () => {
    expect(autoOrganize([], OPTIONS)).toEqual([])
  })

  it('sizes a group to its icons, never taller than half the work area', () => {
    const many = Array.from({ length: 200 }, (_, i) => it_(String(i), `f${i}`, 'file'))
    const [files] = autoOrganize(many, OPTIONS)
    expect(files.h).toBeLessThanOrEqual((AREA.height - 72) / 2)
    const [one] = autoOrganize([it_('1', 'a', 'file')], OPTIONS)
    expect(one.h).toBeLessThan(files.h)
    expect(one.h).toBeGreaterThanOrEqual(120)
  })
})

describe('applyAutoOrganize (layout mutation)', () => {
  function layout(): LayoutFile {
    return {
      ...emptyLayout(),
      displays: [
        {
          ...newDisplayLayout(1, { x: 0, y: 0, width: 1920, height: 1080 }),
          loose: { '1:1': { x: 0, y: 0 }, '1:2': { x: 0, y: 96 } },
          groups: [{ ...group('old'), z: 7, items: ['1:3'] }]
        }
      ]
    }
  }

  function group(id: string, items: string[] = []): Group {
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
      sort: 'name',
      excludeFromQuickHide: false,
      createdAt: 1
    }
  }

  it('adds the groups on top and moves only items that are still loose', () => {
    const next = applyAutoOrganize(layout(), 1, [
      group('apps', ['1:1', '1:3']),
      group('files', ['1:2'])
    ])
    const display = next.displays[0]
    expect(display.loose).toEqual({})
    expect(display.groups.map((g) => [g.id, g.items, g.z])).toEqual([
      ['old', ['1:3'], 7],
      ['apps', ['1:1'], 8],
      ['files', ['1:2'], 9]
    ])
  })

  it('skips a group left empty and an id that already exists; same object when nothing changes', () => {
    const start = layout()
    expect(applyAutoOrganize(start, 1, [group('x', ['1:3'])])).toBe(start)
    expect(applyAutoOrganize(start, 1, [group('old', ['1:1'])])).toBe(start)
    expect(applyAutoOrganize(start, 9, [group('x', ['1:1'])])).toBe(start)
  })
})
