import { fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useLayoutStore } from '../../stores/layout'
import { useUiStore } from '../../stores/ui'
import { moveTo, overlay, press, release, renderDesktop } from './dnd-test-utils'

describe('DndProvider', () => {
  it('a press that moves 5 px is a click: no drag starts, the icon is selected', () => {
    const { icon } = renderDesktop()
    const notes = icon('Notes')

    press(notes, 20, 20)
    moveTo(25, 20)
    expect(useUiStore.getState().drag).toBeNull()
    expect(overlay()).toBeNull()
    release(25, 20)
    fireEvent.click(notes, { clientX: 25, clientY: 20 })

    expect(useUiStore.getState().selection).toEqual(['1:1'])
    expect(useLayoutStore.getState().layout.displays[0].loose).toEqual({ '1:1': { x: 0, y: 0 } })
  })

  it('8 px starts the drag: the preview follows, and the drop lands in the grid cell', () => {
    const { icon } = renderDesktop()
    const notes = icon('Notes')

    press(notes, 20, 20)
    moveTo(28, 20)
    expect(useUiStore.getState().drag).toMatchObject({ ids: ['1:1'], activeId: '1:1' })
    expect(overlay()).toHaveTextContent('Notes')
    expect(notes).toHaveAttribute('data-drag-source')

    moveTo(300, 300)
    expect(useUiStore.getState().dropHint).toEqual({ kind: 'canvas', point: { x: 288, y: 288 } })
    expect(document.querySelector('[data-drop-cell]')).toHaveStyle({ left: '288px', top: '288px' })
    release(300, 300)

    expect(useLayoutStore.getState().layout.displays[0].loose).toEqual({
      '1:1': { x: 288, y: 288 }
    })
    expect(useUiStore.getState().drag).toBeNull()
    expect(overlay()).toBeNull()
  })

  it('Escape cancels a drag without moving anything', () => {
    const { icon } = renderDesktop()

    press(icon('Notes'), 20, 20)
    moveTo(120, 20)
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })

    expect(useUiStore.getState().drag).toBeNull()
    expect(overlay()).toBeNull()
    expect(useLayoutStore.getState().layout.displays[0].loose).toEqual({ '1:1': { x: 0, y: 0 } })
  })

  it('double-click still opens the item', () => {
    const { icon, bridge } = renderDesktop()

    fireEvent.doubleClick(icon('Notes'))

    expect(bridge.desktop.open).toHaveBeenCalledExactlyOnceWith('1:1')
  })
})
