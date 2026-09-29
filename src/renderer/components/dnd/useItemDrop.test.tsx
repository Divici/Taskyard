import { renderHook } from '@testing-library/react'
import type { DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/core'
import { describe, expect, it } from 'vitest'
import type { GroupSort, Point } from '@shared/schema'
import { useLayoutStore } from '../../stores/layout'
import { useUiStore } from '../../stores/ui'
import { desktopItem, makeGroup, seedCanvas } from '../../test/canvas-fixtures'
import { mockRect } from '../../test/dnd-rects'
import { installFakeBridge } from '../../test/fake-bridge'
import { CANVAS_DROP_ID, groupDropId, type DropData } from './dnd-types'
import { dropItems } from './drop-actions'
import { useItemDrop } from './useItemDrop'

const AREA = { x: 0, y: 0, width: 2560, height: 1392 }
const CELL = { width: 96, height: 96 }
const ITEMS = ['Notes', 'Plan', 'Budget', 'Code', 'Mail', 'Photo'].map((name, index) =>
  desktopItem(`1:${index + 1}`, name)
)

function seed(sortB: GroupSort = 'manual'): void {
  installFakeBridge()
  seedCanvas({
    items: ITEMS,
    groups: [
      makeGroup('a', { items: ['1:1', '1:2', '1:3'], z: 1 }),
      makeGroup('b', { items: ['1:4', '1:5'], x: 400, z: 2, sort: sortB })
    ],
    loose: { '1:6': { x: 0, y: 600 } }
  })
}

/** A rendered group body: 3 columns of 80 px cells at (400, 76), holding `ids`. */
function groupBody(ids: string[]): HTMLElement {
  const element = document.createElement('div')
  element.dataset.columns = '3'
  element.dataset.cellHeight = '80'
  for (const id of ids) {
    const option = document.createElement('div')
    option.dataset.itemId = id
    element.append(option)
  }
  document.body.append(element)
  mockRect(element, { x: 400, y: 76, width: 256, height: 160 })
  return element
}

function over(id: string, data: DropData): DragEndEvent['over'] {
  return { id, data: { current: data }, rect: null!, disabled: false }
}

const groupB = (sort: GroupSort = 'manual'): DragEndEvent['over'] =>
  over(groupDropId('b'), {
    kind: 'group',
    groupId: 'b',
    z: 2,
    sort,
    body: () => groupBody(['1:4', '1:5'])
  })
const canvas = (): DragEndEvent['over'] => over(CANVAS_DROP_ID, { kind: 'canvas' })

type AnyDragEvent = DragEndEvent & DragStartEvent & DragMoveEvent

function dragEvent(
  activeId: string,
  from: Point,
  to: Point,
  target: DragEndEvent['over']
): AnyDragEvent {
  return {
    active: {
      id: activeId,
      data: { current: { kind: 'item', itemId: activeId } },
      rect: { current: { initial: null, translated: null } }
    },
    activatorEvent: new PointerEvent('pointerdown', { clientX: from.x, clientY: from.y }),
    delta: { x: to.x - from.x, y: to.y - from.y },
    over: target,
    collisions: null
  } as unknown as AnyDragEvent
}

function setup(): ReturnType<typeof useItemDrop> {
  const { result } = renderHook(() => useItemDrop({ displayId: 1, area: AREA, cell: CELL }))
  return result.current
}

const display = (): ReturnType<typeof useLayoutStore.getState>['layout']['displays'][number] =>
  useLayoutStore.getState().layout.displays[0]

describe('useItemDrop', () => {
  it('inserts into a manual group at the index under the pointer (group → group)', () => {
    seed()
    const drop = setup()
    // Cell 1 of group b's first row, left half: before "Mail" (1:5).
    const event = dragEvent('1:1', { x: 60, y: 90 }, { x: 490, y: 100 }, groupB())

    drop.onDragStart(event)
    expect(useUiStore.getState().drag).toEqual({
      ids: ['1:1'],
      activeId: '1:1',
      sourceGroups: ['a'],
      pointer: true
    })
    expect(useUiStore.getState().selection).toEqual(['1:1'])

    drop.onDragMove(event)
    expect(useUiStore.getState().dropHint).toEqual({ kind: 'group', groupId: 'b', index: 1 })

    drop.onDragEnd(event)
    expect(display().groups.map((g) => g.items)).toEqual([
      ['1:2', '1:3'],
      ['1:4', '1:1', '1:5']
    ])
    expect(useUiStore.getState().drag).toBeNull()
    expect(useUiStore.getState().dropHint).toBeNull()
  })

  it('moves a multi-selection in the order it is shown, whatever order it was clicked in', () => {
    seed()
    useUiStore.getState().select(['1:6', '1:3', '1:1'])
    const drop = setup()
    // Past the last icon of group b: the end.
    const event = dragEvent('1:3', { x: 200, y: 90 }, { x: 640, y: 100 }, groupB())

    drop.onDragStart(event)
    expect(useUiStore.getState().drag?.ids).toEqual(['1:1', '1:3', '1:6'])
    drop.onDragEnd(event)

    expect(display().groups[1].items).toEqual(['1:4', '1:5', '1:1', '1:3', '1:6'])
    expect(display().groups[0].items).toEqual(['1:2'])
    expect(display().loose).toEqual({})
    // The selection is kept (Explorer keeps the moved items selected).
    expect(useUiStore.getState().selection).toEqual(['1:6', '1:3', '1:1'])
  })

  it('drops onto the desktop in the grid cell nearest the pointer (group → canvas)', () => {
    seed()
    const drop = setup()
    const event = dragEvent('1:2', { x: 150, y: 90 }, { x: 205, y: 350 }, canvas())

    drop.onDragStart(event)
    drop.onDragMove(event)
    expect(useUiStore.getState().dropHint).toEqual({ kind: 'canvas', point: { x: 192, y: 288 } })
    drop.onDragEnd(event)

    expect(display().loose).toEqual({ '1:6': { x: 0, y: 600 }, '1:2': { x: 192, y: 288 } })
    expect(display().groups[0].items).toEqual(['1:1', '1:3'])
  })

  it('appends to a group with another sort (canvas → group), without an insert indicator', () => {
    seed('name')
    const drop = setup()
    const event = dragEvent('1:6', { x: 40, y: 640 }, { x: 410, y: 100 }, groupB('name'))

    drop.onDragStart(event)
    drop.onDragMove(event)
    expect(useUiStore.getState().dropHint).toEqual({ kind: 'group', groupId: 'b', index: null })
    drop.onDragEnd(event)
    expect(display().groups[1].items).toEqual(['1:4', '1:5', '1:6'])
    expect(display().loose).toEqual({})
  })

  it('round 2: a drag inside a sorted group reorders it from the order shown and makes it manual', () => {
    seed('name')
    // Shown by name: Code (1:4), Mail (1:5). Code goes past the middle of Mail: after it.
    const drop = setup()
    const event = dragEvent('1:4', { x: 440, y: 100 }, { x: 540, y: 100 }, groupB('name'))

    drop.onDragStart(event)
    drop.onDragMove(event)
    expect(useUiStore.getState().dropHint).toEqual({ kind: 'group', groupId: 'b', index: 2 })
    drop.onDragEnd(event)

    expect(display().groups[1]).toMatchObject({ sort: 'manual', items: ['1:5', '1:4'] })
  })

  it('round 2: dropping an icon back on its own spot in a sorted group changes nothing', () => {
    seed('name')
    const before = useLayoutStore.getState().layout
    const drop = setup()
    const again = dragEvent('1:4', { x: 410, y: 100 }, { x: 412, y: 100 }, groupB('name'))
    drop.onDragStart(again)
    drop.onDragEnd(again)
    expect(useLayoutStore.getState().layout).toBe(before)
  })

  it('a drop of a member onto its sorted group with no insert point (an Explorer drop) keeps it sorted', () => {
    seed('name')
    const before = useLayoutStore.getState().layout
    dropItems({ displayId: 1, area: AREA, cell: CELL }, ['1:4'], '1:4', {
      kind: 'group',
      groupId: 'b',
      index: null,
      beforeId: null,
      shown: ['1:4', '1:5']
    })
    expect(useLayoutStore.getState().layout).toBe(before)
  })

  it('a drop on nothing, or a cancelled drag, changes nothing and clears the drag', () => {
    seed()
    const drop = setup()
    const before = useLayoutStore.getState().layout

    const nowhere = dragEvent('1:1', { x: 60, y: 90 }, { x: 60, y: 300 }, null)
    drop.onDragStart(nowhere)
    drop.onDragEnd(nowhere)
    drop.onDragStart(nowhere)
    drop.onDragCancel(nowhere)

    expect(useLayoutStore.getState().layout).toBe(before)
    expect(useUiStore.getState().drag).toBeNull()
  })
})
