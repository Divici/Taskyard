import type { KeyboardEvent } from 'react'
import type { KeyInput } from './keyboard'

const TEXT_FIELDS = 'input, textarea, select, [contenteditable="true"]'

/** Shift+F10 or the menu key: Windows' keyboard route to a context menu. */
export function isContextMenuKey(event: Pick<KeyInput, 'key' | 'shiftKey'>): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
}

/**
 * Opens the context menu of whatever owns the focused element, as a right-click there would:
 * a `contextmenu` event at the focused element (below it, or at its centre for a large surface)
 * that bubbles to the nearest menu trigger. Keys a child already handled (an icon opens its own
 * menu and prevents the default) are left alone, and handling the key prevents Chromium's own
 * keyboard contextmenu, so a menu never opens twice.
 */
export function openMenuFromKey(
  event: KeyboardEvent<HTMLElement>,
  at: 'below' | 'center' = 'below'
): void {
  if (event.defaultPrevented || !isContextMenuKey(event)) return
  const focused = event.target instanceof HTMLElement ? event.target : event.currentTarget
  // A text field keeps Chromium's own edit menu (cut, copy, paste).
  if (focused.closest(TEXT_FIELDS)) return
  event.preventDefault()
  const rect = focused.getBoundingClientRect()
  focused.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: at === 'center' ? rect.left + rect.width / 2 : rect.left,
      clientY: at === 'center' ? rect.top + rect.height / 2 : rect.bottom
    })
  )
}
