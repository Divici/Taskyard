import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { WallpaperInfo } from '@shared/ipc'

/**
 * This window's wallpaper as main describes it (`wallpaper:get`). Not persisted; written only by
 * src/renderer/lib/wallpaper-sync.ts. The layer paints it; the settings inspector reads `hint`.
 */
export interface WallpaperState {
  /** Null until main answers (or when it knows no such display): paint black. */
  info: WallpaperInfo | null
  setInfo(info: WallpaperInfo | null): void
}

export function createWallpaperStore(): UseBoundStore<StoreApi<WallpaperState>> {
  return create<WallpaperState>()((set) => ({
    info: null,
    setInfo: (info) => set({ info: info === null ? null : structuredClone(info) })
  }))
}

export const useWallpaperStore = createWallpaperStore()
