import type { SaveResultOf } from '@shared/ipc'
import { updateTools } from '@shared/layout-mutations'
import type { LayoutFile, SettingsFile, TasksFile } from '@shared/schema'
import { formatClock, timerRemaining } from '@shared/timer-state'

// Main-side control of the tools widget and the timer, for the tray (Phase 11): "Show/Hide tools
// widget" and the tooltip's remaining time. Main saves through its own stores (no base
// revision), and every window follows through `storage:changed`, like any other save.

/** The slice of main's storage used here (src/main/storage/stores.ts). */
export interface ToolsControlStorage {
  layout: { get(): LayoutFile; save(data: LayoutFile): SaveResultOf<LayoutFile> }
  settings: { get(): SettingsFile; save(data: SettingsFile): SaveResultOf<SettingsFile> }
}

/** Whether any display shows the widget (the master switch `toolsEnabled` must be on too). */
export function toolsShownAnywhere(layout: LayoutFile, settings: SettingsFile): boolean {
  return settings.toolsEnabled && layout.displays.some((display) => display.tools.visible)
}

/** Shows or hides the widget on the listed displays; the same layout when nothing changes. */
export function setToolsVisible(
  layout: LayoutFile,
  visible: boolean,
  displayIds: readonly number[]
): LayoutFile {
  return displayIds.reduce(
    (current, displayId) =>
      updateTools(current, displayId, (tools) =>
        tools.visible === visible ? tools : { ...tools, visible }
      ),
    layout
  )
}

/**
 * The tray's "Show/Hide tools widget": hides it on every display when it is shown anywhere;
 * otherwise shows it on `primaryDisplayId` (turning `toolsEnabled` back on). Returns whether the
 * widget is shown afterwards.
 */
export function toggleToolsWidget(storage: ToolsControlStorage, primaryDisplayId: number): boolean {
  const layout = storage.layout.get()
  const settings = storage.settings.get()
  if (toolsShownAnywhere(layout, settings)) {
    const all = layout.displays.map((display) => display.displayId)
    const hidden = setToolsVisible(layout, false, all)
    if (hidden !== layout) storage.layout.save(hidden)
    return false
  }
  if (!settings.toolsEnabled) storage.settings.save({ ...settings, toolsEnabled: true })
  const shown = setToolsVisible(layout, true, [primaryDisplayId])
  if (shown !== layout) storage.layout.save(shown)
  return true
}

/** The tray tooltip's timer line while a countdown runs or is paused; null otherwise. */
export function timerStatusText(tasks: TasksFile, now: number): string | null {
  const { timer } = tasks
  if (timer.status === 'running') return `Timer ${formatClock(timerRemaining(timer, now))} left`
  if (timer.status === 'paused') return `Timer paused at ${formatClock(timerRemaining(timer, now))}`
  return null
}
