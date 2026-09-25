import type { StoreApi } from 'zustand'
import type { TaskyardApi } from '../../preload/api'
import { useDisplayStore, type DisplayState } from '../stores/display'
import { useUiStore, type UiState } from '../stores/ui'

export interface InspectorSyncTargets {
  display: Pick<StoreApi<DisplayState>, 'getState'>
  ui: Pick<StoreApi<UiState>, 'getState'>
}

/**
 * Phase 11: the tray's "Settings…" names one display (the primary); only the window covering it
 * opens its inspector. Returns the disconnect.
 */
export function connectInspector(
  api: Pick<TaskyardApi, 'on'>,
  targets: InspectorSyncTargets = { display: useDisplayStore, ui: useUiStore }
): () => void {
  return api.on('inspector:open', ({ displayId }) => {
    if (displayId === targets.display.getState().displayId) {
      targets.ui.getState().setInspectorOpen(true)
    }
  })
}
