import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { DesktopChange } from '@shared/ipc'
import { splitItemName } from '@shared/item-name'
import type { DesktopItem } from '@shared/schema'

export interface ItemIcon {
  px: number
  dataUrl: string
}

/**
 * The desktop items main reports, by file id. Not persisted: main's scan is the source of truth.
 * Phase 4/7 wire applyChange → layout.reconcile and applyRenamed → layout.onRenamed.
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
}

function pick<V>(record: Record<string, V>, keep: (id: string) => boolean): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => keep(id)))
}

export function createItemsStore(): UseBoundStore<StoreApi<ItemsState>> {
  return create<ItemsState>()((set) => ({
    byId: {},
    icons: {},
    hydrated: false,

    hydrate(list) {
      const byId = Object.fromEntries(list.map((item) => [item.id, item]))
      set(({ icons }) => ({ byId, icons: pick(icons, (id) => id in byId), hydrated: true }))
    },

    applyChange({ added, removed, changed }) {
      set(({ byId, icons }) => {
        const gone = new Set(removed)
        const next = pick(byId, (id) => !gone.has(id))
        for (const item of [...added, ...changed]) next[item.id] = item
        return { byId: next, icons: pick(icons, (id) => !gone.has(id)) }
      })
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
    }
  }))
}

export const useItemsStore = createItemsStore()
