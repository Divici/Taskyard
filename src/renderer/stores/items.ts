import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { DesktopChange } from '@shared/ipc'
import { splitItemName } from '@shared/item-name'
import type { DesktopItem } from '@shared/schema'

export interface ItemIcon {
  px: number
  dataUrl: string
}

/** Told the ids present on the desktop after every hydrate and applyChange. */
export type ItemsChangedListener = (presentIds: string[]) => void

/**
 * The desktop items main reports, by file id. Not persisted: main's scan is the source of truth.
 * Reconcile seam: Phase 7 registers `layout.reconcile` with `onItemsChanged`, and it runs after
 * every hydrate and applyChange with the present ids. `applyRenamed` only updates the item:
 * main updates the layout's `paths[id]` itself on a rename (R12).
 */
export interface ItemsState {
  byId: Record<string, DesktopItem>
  icons: Record<string, ItemIcon>
  hydrated: boolean
  /** Replaces every item with a full scan; icons for ids not in it are dropped. */
  hydrate(list: DesktopItem[]): void
  applyChange(change: DesktopChange): void
  /** A rename keeps the id; path, name and extension follow the new path. */
  applyRenamed(id: string, path: string): void
  /** Keeps the sharpest icon: a smaller size never replaces a larger one. */
  setIcon(id: string, px: number, dataUrl: string): void
  /** Registers the reconcile hook (Phase 7); returns the unsubscribe. */
  onItemsChanged(listener: ItemsChangedListener): () => void
}

function pick<V>(record: Record<string, V>, keep: (id: string) => boolean): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => keep(id)))
}

export function createItemsStore(): UseBoundStore<StoreApi<ItemsState>> {
  // Outside zustand's state: registering a hook must not re-render anything.
  const listeners = new Set<ItemsChangedListener>()
  const announce = (byId: Record<string, DesktopItem>): void => {
    const presentIds = Object.keys(byId)
    for (const listener of [...listeners]) {
      try {
        listener(presentIds)
      } catch (error) {
        console.error('items: an onItemsChanged listener failed', error)
      }
    }
  }

  return create<ItemsState>()((set, get) => ({
    byId: {},
    icons: {},
    hydrated: false,

    hydrate(list) {
      const byId = Object.fromEntries(list.map((item) => [item.id, item]))
      set(({ icons }) => ({ byId, icons: pick(icons, (id) => id in byId), hydrated: true }))
      announce(get().byId)
    },

    applyChange({ added, removed, changed }) {
      set(({ byId, icons }) => {
        const gone = new Set(removed)
        const next = pick(byId, (id) => !gone.has(id))
        for (const item of [...added, ...changed]) next[item.id] = item
        return { byId: next, icons: pick(icons, (id) => !gone.has(id)) }
      })
      announce(get().byId)
    },

    applyRenamed(id, path) {
      set(({ byId }) => {
        const item = byId[id]
        if (!item) return {}
        return { byId: { ...byId, [id]: { ...item, path, ...splitItemName(path, item.kind) } } }
      })
    },

    setIcon(id, px, dataUrl) {
      set(({ icons }) => {
        const current = icons[id]
        if (current && current.px > px) return {}
        return { icons: { ...icons, [id]: { px, dataUrl } } }
      })
    },

    onItemsChanged(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }))
}

export const useItemsStore = createItemsStore()
