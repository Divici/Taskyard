import { GROUP_HEADER_HEIGHT, visibleGroupRect } from '@shared/group-metrics'
import type { Rect } from '@shared/schema'
import type { SnapOptions } from '@shared/snapping'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'

// Round 2: what a moving or resizing window (a group, the tools widget) snaps to — every other
// window shown on its display, read from the stores when the press starts.

/** The window an element belongs to: `group:<id>`, `tools`, or null outside any window. */
export function snapKeyOf(element: Element): string | null {
  const group = element.closest<HTMLElement>('[data-group-id]')
  if (group) return `group:${group.dataset.groupId}`
  return element.closest('[data-tools-widget]') ? 'tools' : null
}

/** The on-screen rects of the windows shown on a display, by snap key. */
export function shownWindows(displayId: number): Array<{ key: string; rect: Rect }> {
  const display = useLayoutStore
    .getState()
    .layout.displays.find((entry) => entry.displayId === displayId)
  if (!display) return []
  const quickHidden = useUiStore.getState().quickHidden
  const windows = display.groups
    .filter((group) => !quickHidden || group.excludeFromQuickHide)
    .map((group) => ({ key: `group:${group.id}`, rect: visibleGroupRect(group) }))
  const { tools } = display
  const toolsOn = useSettingsStore.getState().settings.toolsEnabled && tools.visible
  if (!toolsOn || quickHidden) return windows
  const height = tools.rolledUp ? GROUP_HEADER_HEIGHT : tools.h
  return [...windows, { key: 'tools', rect: { x: tools.x, y: tools.y, width: tools.w, height } }]
}

/**
 * The snap options for a drag of the window `element` belongs to: the other windows on its
 * display (the canvas's `data-desktop-canvas`), and the grid step when grid snap is on.
 */
export function snapOptionsFor(element: Element, area: Rect, snap: boolean): SnapOptions {
  const canvas = element.closest<HTMLElement>('[data-desktop-canvas]')
  const self = snapKeyOf(element)
  const targets = canvas
    ? shownWindows(Number(canvas.dataset.desktopCanvas))
        .filter((window) => window.key !== self)
        .map((window) => window.rect)
    : []
  return { area, grid: snap ? useSettingsStore.getState().settings.gridSize : null, targets }
}
