import { useDisplayStore } from '../stores/display'
import { useItemsStore } from '../stores/items'
import { useLayoutStore } from '../stores/layout'
import { useSettingsStore } from '../stores/settings'
import { useTasksStore } from '../stores/tasks'
import { useUiStore } from '../stores/ui'

/** Puts every app-wide zustand store back to the state it was created with. */
export function resetStores(): void {
  // Persisted stores keep their synced document (revision, unsaved changes) outside zustand's
  // state, so they reset through their own action.
  useSettingsStore.getState().reset()
  useLayoutStore.getState().reset()
  useTasksStore.getState().reset()
  useItemsStore.setState(useItemsStore.getInitialState(), true)
  useUiStore.setState(useUiStore.getInitialState(), true)
  useDisplayStore.setState(useDisplayStore.getInitialState(), true)
}
