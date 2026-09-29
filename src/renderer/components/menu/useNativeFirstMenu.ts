import { useRef } from 'react'
import type { Point } from '@shared/schema'

/** Where and how a native menu was asked for (the right-click, or its keyboard stand-in). */
export interface NativeMenuAt {
  /** The event's clientX / clientY: window CSS px. */
  point: Point
  shiftKey: boolean
}

/**
 * Shows the real Windows menu for a right-click instead of a Taskyard (Radix) context menu.
 * Resolves false when it could not, and the Taskyard menu then opens at the same point.
 */
export type NativeMenuHandler = (at: NativeMenuAt) => Promise<boolean>

/**
 * Native menus (Phases 3–4): the `onContextMenu` of a Radix `ContextMenuTrigger` whose menu is the
 * fallback. A right-click (or Shift+F10 / the menu key, which dispatch `contextmenu`) goes to
 * `onNativeMenu` first and the Radix menu is held back; when the native menu could not show, the
 * same `contextmenu` is dispatched again on the trigger and this time let through, so the Taskyard
 * menu opens at the same point. Without `onNativeMenu` every event is let through at once.
 */
export function useNativeFirstMenu(
  onNativeMenu: NativeMenuHandler | undefined
): (event: React.MouseEvent<HTMLElement>) => void {
  /** The next contextmenu is the fallback re-dispatched here: let Radix open it. */
  const fallbackNext = useRef(false)

  return (event) => {
    if (fallbackNext.current) {
      fallbackNext.current = false
      return
    }
    if (!onNativeMenu) return
    // No Radix menu now: the native one shows, or this one follows as the fallback.
    event.preventDefault()
    const trigger = event.currentTarget
    const init: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      clientX: event.clientX,
      clientY: event.clientY
    }
    void onNativeMenu({
      point: { x: event.clientX, y: event.clientY },
      shiftKey: event.shiftKey
    }).then((handled) => {
      if (handled || !trigger.isConnected) return
      fallbackNext.current = true
      trigger.dispatchEvent(new MouseEvent('contextmenu', init))
    })
  }
}
