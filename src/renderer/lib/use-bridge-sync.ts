import { useEffect } from 'react'
import { hydrateStores } from '../stores/hydrate'
import { useUiStore } from '../stores/ui'
import { getBridge } from './bridge'
import { subscribeBridgeEvents } from './bridge-events'
import { connectDesktop } from './desktop-sync'
import { connectDisplay } from './display-sync'
import { LOAD_FAILED_TOAST } from './storage-messages'

/**
 * Connects the app's stores to main for the lifetime of the component: subscribes to the events
 * first (so nothing sent during hydration is missed), then hydrates from disk, connects this
 * window to its display (which registers the display in the layout) and lists the desktop.
 */
export function useBridgeSync(): void {
  useEffect(() => {
    let api
    try {
      api = getBridge()
    } catch (error) {
      console.error('storage: no bridge to main', error)
      useUiStore.getState().pushToast(LOAD_FAILED_TOAST)
      return
    }
    const unsubscribe = subscribeBridgeEvents(api)
    const disconnectDisplay = connectDisplay(api, window.location.search)
    const disconnectDesktop = connectDesktop(api)
    void hydrateStores(api)
    return () => {
      disconnectDesktop()
      disconnectDisplay()
      unsubscribe()
    }
  }, [])
}
