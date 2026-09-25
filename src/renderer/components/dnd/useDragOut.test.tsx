import { waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { desktopItem } from '../../test/canvas-fixtures'
import { useLayoutStore } from '../../stores/layout'
import { useUiStore } from '../../stores/ui'
import { moveTo, NOTES, overlay, press, release, renderDesktop } from './dnd-test-utils'

const PLAN = desktopItem('1:2', 'Plan')

describe('useDragOut', () => {
  it('leaving the window cancels the dnd-kit drag and clears the preview before asking main for the OS drag', async () => {
    const { icon, bridge } = renderDesktop({
      items: [NOTES, PLAN],
      loose: { '1:1': { x: 0, y: 0 }, '1:2': { x: 0, y: 96 } }
    })
    useUiStore.getState().select(['1:1', '1:2'])
    const seen: Array<{ drag: unknown; overlay: boolean }> = []
    bridge.desktop.startDrag.mockImplementation(async () => {
      seen.push({ drag: useUiStore.getState().drag, overlay: overlay() !== null })
      return true
    })

    press(icon('Notes'), 20, 20)
    moveTo(60, 20)
    expect(overlay()).not.toBeNull()
    moveTo(-3, 400) // past the window's left edge (the other monitor)

    expect(bridge.desktop.startDrag).toHaveBeenCalledExactlyOnceWith(['1:1', '1:2'])
    expect(seen).toEqual([{ drag: null, overlay: false }])
    expect(useUiStore.getState().dropHint).toBeNull()

    // dnd-kit is not stuck: the release (after the OS drag) changes nothing, and a new drag works.
    moveTo(10, 10)
    release(10, 10)
    expect(useLayoutStore.getState().layout.displays[0].loose).toEqual({
      '1:1': { x: 0, y: 0 },
      '1:2': { x: 0, y: 96 }
    })
    press(icon('Plan'), 20, 120)
    moveTo(40, 120)
    expect(useUiStore.getState().drag).toMatchObject({ activeId: '1:2' })
    expect(overlay()).not.toBeNull()
    release(40, 120)
  })

  it('hands over when another app’s window is under the cursor (it covers the desktop there)', async () => {
    const { icon, bridge } = renderDesktop()
    bridge.desktop.cursorOverOtherWindow.mockResolvedValue(true)

    press(icon('Notes'), 20, 20)
    moveTo(60, 20)
    moveTo(400, 300)

    await waitFor(() => expect(bridge.desktop.startDrag).toHaveBeenCalledExactlyOnceWith(['1:1']))
    expect(overlay()).toBeNull()
    expect(useUiStore.getState().drag).toBeNull()
  })

  it('stays an in-page drag while the desktop itself is under the cursor', async () => {
    const { icon, bridge } = renderDesktop()

    press(icon('Notes'), 20, 20)
    moveTo(60, 20)
    moveTo(400, 300)
    await waitFor(() => expect(bridge.desktop.cursorOverOtherWindow).toHaveBeenCalled())
    release(400, 300)

    expect(bridge.desktop.startDrag).not.toHaveBeenCalled()
    expect(useLayoutStore.getState().layout.displays[0].loose).toEqual({
      '1:1': { x: 384, y: 288 }
    })
  })
})
