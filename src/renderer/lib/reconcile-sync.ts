import type { StoreApi } from 'zustand'
import { localWorkArea } from '@shared/geometry'
import { looseCell } from '@shared/group-metrics'
import type { DisplayInfo } from '@shared/ipc'
import { hasDisplay } from '@shared/layout-mutations'
import { useDisplayStore, type DisplayState } from '../stores/display'
import { useItemsStore, type ItemsState } from '../stores/items'
import { useLayoutStore, type LayoutState } from '../stores/layout'
import { useSettingsStore, type SettingsState } from '../stores/settings'

type Readable<S> = Pick<StoreApi<S>, 'getState' | 'subscribe'>

export interface ReconcileTargets {
  items: Readable<ItemsState>
  layout: Readable<LayoutState>
  display: Readable<DisplayState>
  settings: Pick<StoreApi<SettingsState>, 'getState'>
}

const APP_TARGETS: ReconcileTargets = {
  items: useItemsStore,
  layout: useLayoutStore,
  display: useDisplayStore,
  settings: useSettingsStore
}

/**
 * Windows puts the primary display's top-left corner at the origin of the virtual screen, and
 * Electron's DIP bounds keep it there.
 */
export function isPrimaryDisplay(info: Pick<DisplayInfo, 'bounds'>): boolean {
  return info.bounds.x === 0 && info.bounds.y === 0
}

/**
 * Keeps the layout in line with the files on disk (`layout.reconcile`), from the primary
 * display's window only — the single writer, so two windows never place the same new file
 * twice. It runs once everything it needs is known (items listed, layout loaded, this display
 * described and registered in the layout), then after every desktop change (`onItemsChanged`:
 * hydrate and applyChange). Other windows only read. Returns the disconnect.
 */
export function connectReconcile(
  targets: ReconcileTargets = APP_TARGETS,
  now: () => number = Date.now
): () => void {
  const { items, layout, display, settings } = targets

  const primaryInfo = (): DisplayInfo | null => {
    const info = display.getState().info
    return info && isPrimaryDisplay(info) ? info : null
  }

  const ready = (): boolean => {
    const info = primaryInfo()
    const { layout: current, hydrated } = layout.getState()
    return info !== null && items.getState().hydrated && hydrated && hasDisplay(current, info.id)
  }

  const run = (): void => {
    const info = primaryInfo()
    if (!info || !ready()) return
    const present = Object.values(items.getState().byId).map(({ id, path, name }) => ({
      id,
      path,
      name
    }))
    layout.getState().reconcile(present, {
      now: now(),
      place: {
        displayId: info.id,
        area: localWorkArea(info),
        cell: looseCell(settings.getState().settings.iconSize)
      }
    })
  }

  let wasReady = false
  const check = (): void => {
    const isReady = ready()
    if (isReady && !wasReady) run()
    wasReady = isReady
  }

  const unsubscribers = [
    items.getState().onItemsChanged(() => {
      if (ready()) run()
    }),
    items.subscribe(check),
    layout.subscribe(check),
    display.subscribe(check)
  ]
  check()

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}
