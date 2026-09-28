import type { StoreApi } from 'zustand'
import type { DesktopChange, DesktopRenamed } from '@shared/ipc'
import type { TaskyardApi } from '../../preload/api'
import { useItemsStore, type ItemsState } from '../stores/items'
import { useUiStore, type ToastInput, type UiState } from '../stores/ui'

export interface DesktopSyncTargets {
  items: Pick<StoreApi<ItemsState>, 'getState'>
  ui: Pick<StoreApi<UiState>, 'getState'>
}

const APP_TARGETS: DesktopSyncTargets = { items: useItemsStore, ui: useUiStore }

export const DESKTOP_LOAD_FAILED_TOAST: ToastInput = {
  id: 'desktop-load-failed',
  tone: 'error',
  message: 'Taskyard couldn’t read your desktop. Use “Refresh desktop” to try again.',
  durationMs: null
}

type DesktopEvent =
  { kind: 'changed'; change: DesktopChange } | { kind: 'renamed'; renamed: DesktopRenamed }

/**
 * Fills the items store from main: subscribes to desktop:changed / desktop:renamed first, then
 * asks for the full list (`desktop:list`). Events that arrive while the list is in flight are
 * held and replayed on top of it, in order. Each one sets an item to a definite state, so one
 * already contained in the list changes nothing, and one sent after the list was built is not
 * lost. Returns the disconnect.
 */
export function connectDesktop(
  api: Pick<TaskyardApi, 'desktop' | 'on'>,
  targets: DesktopSyncTargets = APP_TARGETS
): () => void {
  let connected = true
  let held: DesktopEvent[] | null = []

  const apply = (event: DesktopEvent): void => {
    const items = targets.items.getState()
    if (event.kind === 'changed') items.applyChange(event.change)
    else items.applyRenamed(event.renamed.id, event.renamed.path)
  }
  const receive = (event: DesktopEvent): void => {
    if (held) held.push(event)
    else apply(event)
  }
  const release = (): void => {
    const pending = held ?? []
    held = null
    for (const event of pending) apply(event)
  }

  // Icons main sent before this window listened (desktop:icon); later ones stream in. setIcon
  // keeps the sharpest, so the order against streamed icons does not matter.
  const pullIcons = (): void => {
    api.desktop.icons().then(
      (icons) => {
        if (!connected) return
        const items = targets.items.getState()
        for (const { id, px, dataUrl, version } of icons) items.setIcon(id, px, dataUrl, version)
        // Main answers once its icon pass is idle: the skeleton tiles can go.
        items.setIconsLoaded()
      },
      (error: unknown) => {
        if (!connected) return
        console.error('desktop: fetching the icons failed', error)
        targets.items.getState().setIconsLoaded()
      }
    )
  }

  const unsubscribers = [
    api.on('desktop:changed', (change) => receive({ kind: 'changed', change })),
    api.on('desktop:renamed', (renamed) => receive({ kind: 'renamed', renamed }))
  ]

  api.desktop.list().then(
    (list) => {
      if (!connected) return
      targets.items.getState().hydrate(list)
      release()
      pullIcons()
    },
    (error: unknown) => {
      if (!connected) return
      console.error('desktop: listing the desktop failed', error)
      targets.ui.getState().pushToast(DESKTOP_LOAD_FAILED_TOAST)
      release()
    }
  )

  return () => {
    connected = false
    held = null
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}
