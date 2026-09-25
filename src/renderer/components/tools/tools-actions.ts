import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { patchTools } from './tools-geometry'

/** Whether the tools widget shows on the display (Settings' master switch and its own flag). */
export function toolsShownOn(displayId: number): boolean {
  const enabled = useSettingsStore.getState().settings.toolsEnabled
  const tools = useLayoutStore
    .getState()
    .layout.displays.find((display) => display.displayId === displayId)?.tools
  return enabled && (tools?.visible ?? false)
}

/**
 * The desktop menu's "Show/Hide tools widget" for this display. Showing it also turns Settings'
 * `toolsEnabled` back on (otherwise the item would do nothing visible).
 */
export function toggleToolsOn(displayId: number): void {
  if (toolsShownOn(displayId)) {
    useLayoutStore.getState().updateTools(displayId, patchTools({ visible: false }))
    return
  }
  if (!useSettingsStore.getState().settings.toolsEnabled) {
    useSettingsStore.getState().update({ toolsEnabled: true })
  }
  useLayoutStore.getState().updateTools(displayId, patchTools({ visible: true }))
}
