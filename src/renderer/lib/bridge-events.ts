import type { StoreApi } from 'zustand'
import type { StorageChanged } from '@shared/ipc'
import type { TaskyardApi } from '../../preload/api'
import { useItemsStore, type ItemsState } from '../stores/items'
import { useLayoutStore, type LayoutState } from '../stores/layout'
import { useSettingsStore, type SettingsState } from '../stores/settings'
import { useTasksStore, type TasksState } from '../stores/tasks'
import { useUiStore, type UiState } from '../stores/ui'
import { recoveryToast } from './storage-messages'

export interface BridgeEventTargets {
  items: Pick<StoreApi<ItemsState>, 'getState'>
  settings: Pick<StoreApi<SettingsState>, 'getState'>
  layout: Pick<StoreApi<LayoutState>, 'getState'>
  tasks: Pick<StoreApi<TasksState>, 'getState'>
  ui: Pick<StoreApi<UiState>, 'getState'>
}

export const APP_EVENT_TARGETS: BridgeEventTargets = {
  items: useItemsStore,
  settings: useSettingsStore,
  layout: useLayoutStore,
  tasks: useTasksStore,
  ui: useUiStore
}

function applyStorageChanged(changed: StorageChanged, targets: BridgeEventTargets): void {
  switch (changed.store) {
    case 'settings':
      targets.settings.getState().receive(changed)
      break
    case 'layout':
      targets.layout.getState().receive(changed)
      break
    case 'tasks':
      targets.tasks.getState().receive(changed)
      break
  }
}

/**
 * Routes main's events into the stores: icons → items (desktop:changed / desktop:renamed are
 * ordered against desktop:list in desktop-sync.ts), recoveries → toasts, and every
 * accepted save (this window's echo included) → that store's `receive`, which adopts newer
 * revisions and replays its own unsaved changes on top. Returns one unsubscribe for all of them.
 */
export function subscribeBridgeEvents(
  api: Pick<TaskyardApi, 'on'>,
  targets: BridgeEventTargets = APP_EVENT_TARGETS
): () => void {
  const unsubscribers = [
    api.on('desktop:icon', ({ id, px, dataUrl }) =>
      targets.items.getState().setIcon(id, px, dataUrl)
    ),
    api.on('storage:recovered', (info) => {
      targets.ui.getState().pushToast(recoveryToast(info))
    }),
    api.on('storage:changed', (changed) => applyStorageChanged(changed, targets))
  ]
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}
