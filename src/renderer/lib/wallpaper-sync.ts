import type { StoreApi } from 'zustand'
import type { TaskyardApi } from '../../preload/api'
import { useWallpaperStore, type WallpaperState } from '../stores/wallpaper'

/**
 * Keeps the wallpaper store on this display's wallpaper: asks main once, and again after every
 * `wallpaper:changed` for this display (the new answer carries the new `?v=` URL). Only the
 * newest answer is applied. Returns the disconnect.
 */
export function connectWallpaper(
  api: Pick<TaskyardApi, 'wallpaper' | 'on'>,
  displayId: number,
  store: Pick<StoreApi<WallpaperState>, 'getState'> = useWallpaperStore
): () => void {
  let connected = true
  let latest = 0

  const request = (): void => {
    const ticket = ++latest
    api.wallpaper.get(displayId).then(
      (info) => {
        if (connected && ticket === latest) store.getState().setInfo(info)
      },
      (error: unknown) => {
        if (connected)
          console.error(`wallpaper: asking main for display ${displayId} failed`, error)
      }
    )
  }

  const unsubscribe = api.on('wallpaper:changed', (change) => {
    if (change.displayId === displayId) request()
  })
  request()

  return () => {
    connected = false
    unsubscribe()
  }
}
