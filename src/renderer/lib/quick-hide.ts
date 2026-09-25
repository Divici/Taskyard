import type { TaskyardApi } from '../../preload/api'
import { useUiStore } from '../stores/ui'
import { getBridge } from './bridge'

// Quick-hide (Phase 9): a double-click on the empty desktop fades every display's icons and
// groups out (groups marked "Exclude from quick-hide" stay; Phase 10's tools widget follows
// `ui.quickHidden` too). Main holds the flag in memory and tells every window; nothing is saved,
// so each launch starts with the desktop shown.

/** Shows or hides the desktop here at once, and on the other displays through main. */
export function setQuickHide(hidden: boolean): void {
  useUiStore.getState().setQuickHidden(hidden)
  let api: TaskyardApi
  try {
    api = getBridge()
  } catch (error) {
    console.error('quick-hide: no bridge to main', error)
    return
  }
  api.quickHide
    .set(hidden)
    .catch((error: unknown) => console.error('quick-hide: telling main failed', error))
}

/** The double-click on the empty desktop. */
export function toggleQuickHide(): void {
  setQuickHide(!useUiStore.getState().quickHidden)
}

/**
 * Follows the other displays (`quickHide:changed`) and, for a window that loads while the desktop
 * is hidden, pulls the current state. Returns the disconnect.
 */
export function connectQuickHide(api: Pick<TaskyardApi, 'quickHide' | 'on'>): () => void {
  let connected = true
  let eventSeen = false
  const off = api.on('quickHide:changed', ({ hidden }) => {
    eventSeen = true
    useUiStore.getState().setQuickHidden(hidden)
  })
  api.quickHide.get().then(
    (hidden) => {
      if (connected && !eventSeen) useUiStore.getState().setQuickHidden(hidden)
    },
    (error: unknown) => console.error('quick-hide: asking main failed', error)
  )
  return () => {
    connected = false
    off()
  }
}
