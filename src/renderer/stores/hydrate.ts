import type { StoreApi } from 'zustand'
import type { TaskyardApi } from '../../preload/api'
import { LOAD_FAILED_TOAST, recoveryToast } from '../lib/storage-messages'
import { useLayoutStore, type LayoutState } from './layout'
import { useSettingsStore, type SettingsState } from './settings'
import { useTasksStore, type TasksState } from './tasks'
import { useUiStore, type UiState } from './ui'

export interface HydrationTargets {
  settings: Pick<StoreApi<SettingsState>, 'getState'>
  layout: Pick<StoreApi<LayoutState>, 'getState'>
  tasks: Pick<StoreApi<TasksState>, 'getState'>
  ui: Pick<StoreApi<UiState>, 'getState'>
}

const APP_STORES: HydrationTargets = {
  settings: useSettingsStore,
  layout: useLayoutStore,
  tasks: useTasksStore,
  ui: useUiStore
}

/**
 * Pulls the three persisted stores and the storage status from main. Recoveries become toasts
 * and read-only files feed the banner (both happened at boot, before this window existed). If
 * loading fails the stores stay unhydrated, so none of them can overwrite a file with defaults.
 */
export async function hydrateStores(
  api: Pick<TaskyardApi, 'storage'>,
  targets: HydrationTargets = APP_STORES
): Promise<void> {
  let loaded
  try {
    loaded = await Promise.all([
      api.storage.load('settings'),
      api.storage.load('layout'),
      api.storage.load('tasks'),
      api.storage.status()
    ])
  } catch (error) {
    console.error('storage: loading saved data failed', error)
    targets.ui.getState().pushToast(LOAD_FAILED_TOAST)
    return
  }

  const [settings, layout, tasks, status] = loaded
  targets.settings.getState().receive(settings)
  targets.layout.getState().receive(layout)
  targets.tasks.getState().receive(tasks)

  const ui = targets.ui.getState()
  ui.setReadOnly(status.readOnly)
  for (const recovered of status.recovered) ui.pushToast(recoveryToast(recovered))
}
