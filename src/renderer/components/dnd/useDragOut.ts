import { useEffect } from 'react'
import { flushSync } from 'react-dom'
import { getBridge } from '../../lib/bridge'
import { useUiStore } from '../../stores/ui'
import { DRAG_OUT_PROBE_MS } from './dnd-types'
import { cancelActivePointerDrag } from './sensors'

/** Past the window's edge (the other monitor, the 1 px strip under the window). */
function outsideWindow(event: PointerEvent): boolean {
  return (
    event.clientX < 0 ||
    event.clientY < 0 ||
    event.clientX >= window.innerWidth ||
    event.clientY >= window.innerHeight
  )
}

/**
 * Drag-out (Phase 8): while icons are dragged with the pointer, the drag becomes the OS drag
 * (Explorer, a browser, a mail app…) as soon as the pointer leaves the window, or goes over
 * another app's window — which covers the desktop window there, since the desktop is at the
 * bottom of the z-order (main answers `cursorOverOtherWindow`, at most every 100 ms). The order
 * matters (LOCKED Decision 8): snapshot the dragged ids, cancel the dnd-kit drag and flush the
 * preview away, and only then ask main for `webContents.startDrag` — Windows runs the OS drag as
 * a modal loop, and a dnd-kit drag left active under it would be stuck.
 */
export function useDragOut(): void {
  const pointerDrag = useUiStore((state) => state.drag?.pointer ?? false)

  useEffect(() => {
    if (!pointerDrag) return
    let done = false
    let probing = false
    let lastProbe = -Infinity

    const handOff = (): void => {
      if (done) return
      done = true
      const ids = useUiStore.getState().drag?.ids ?? []
      flushSync(() => {
        cancelActivePointerDrag()
        useUiStore.getState().endDrag()
      })
      if (ids.length === 0) return
      getBridge()
        .desktop.startDrag(ids)
        .catch((error: unknown) => console.error('dnd: the OS drag failed', error))
    }

    const onMove = (event: PointerEvent): void => {
      if (done) return
      if (outsideWindow(event)) {
        handOff()
        return
      }
      const now = performance.now()
      if (probing || now - lastProbe < DRAG_OUT_PROBE_MS) return
      probing = true
      lastProbe = now
      getBridge()
        .desktop.cursorOverOtherWindow()
        .then(
          (over) => {
            probing = false
            if (over && useUiStore.getState().drag?.pointer) handOff()
          },
          () => {
            probing = false
          }
        )
    }

    // Capture phase on the window: before dnd-kit's own listener on the document sees the move.
    window.addEventListener('pointermove', onMove, true)
    return () => {
      done = true
      window.removeEventListener('pointermove', onMove, true)
    }
  }, [pointerDrag])
}
