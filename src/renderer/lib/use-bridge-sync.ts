import { useEffect } from 'react'
import { hydrateStores } from '../stores/hydrate'
import { useUiStore } from '../stores/ui'
import { getBridge } from './bridge'
import { subscribeBridgeEvents } from './bridge-events'
import { connectDesktop } from './desktop-sync'
import { connectDisplay } from './display-sync'
import { connectInspector } from './inspector-sync'
import { connectPeek } from './peek-sync'
import { connectQuickHide } from './quick-hide'
import { connectReconcile } from './reconcile-sync'
import { connectShellMenu } from './shell-menu'
import { LOAD_FAILED_TOAST } from './storage-messages'
import { connectTheme } from './theme'

/**
 * Connects the app's stores to main for the lifetime of the component: subscribes to the events
 * first (so nothing sent during hydration is missed), then hydrates from disk, connects this
 * window to its display (which registers the display in the layout) and lists the desktop. The
 * theme follows the settings and the Windows theme from the start (lib/theme.ts). The primary
 * display's window reconciles the layout with the desktop (lib/reconcile-sync.ts).
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
    const disconnectTheme = connectTheme(api)
    // Before any data arrives, so the first reconcile (primary window only) sees it all.
    const disconnectReconcile = connectReconcile()
    const disconnectDisplay = connectDisplay(api, window.location.search)
    const disconnectDesktop = connectDesktop(api)
    // Native menus (Phase 3): whether they can show, and New ▸ / Paste items placed at the
    // right-click point (after connectDesktop, so the items store has them first).
    const disconnectShellMenu = connectShellMenu(api)
    // Phase 9: Peek (state pull, idle/click-outside signals) and quick-hide across displays.
    const disconnectPeek = connectPeek(api)
    const disconnectQuickHide = connectQuickHide(api)
    // Phase 11: the tray's "Settings…" opens this window's inspector when it names this display.
    const disconnectInspector = connectInspector(api)
    void hydrateStores(api)
    return () => {
      disconnectInspector()
      disconnectShellMenu()
      disconnectQuickHide()
      disconnectPeek()
      disconnectReconcile()
      disconnectDesktop()
      disconnectDisplay()
      disconnectTheme()
      unsubscribe()
    }
  }, [])
}
