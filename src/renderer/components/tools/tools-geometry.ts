import type { Size } from '@shared/geometry'
import type { Rect, ToolsState } from '@shared/schema'

// The tools widget (Phase 10): its tools, their names and the widget's size limits.

export type ToolId = ToolsState['activeTool']

/** The tabs' order, left to right. */
export const TOOL_IDS: readonly ToolId[] = ['tasks', 'timer', 'stopwatch']

/** Each tool's name: its tab's label and the header title while it is active. */
export const TOOL_LABELS: Readonly<Record<ToolId, string>> = {
  tasks: 'Tasks',
  timer: 'Timer',
  stopwatch: 'Stopwatch'
}

/** The widget never gets smaller than this (resize stops here). */
export const TOOLS_MIN_SIZE: Readonly<Size> = { width: 280, height: 220 }

export function toolsRect(tools: ToolsState): Rect {
  return { x: tools.x, y: tools.y, width: tools.w, height: tools.h }
}

/** A tools-state edit that returns the same object when nothing changes (no save). */
export function patchTools(patch: Partial<ToolsState>): (tools: ToolsState) => ToolsState {
  return (tools) =>
    (Object.keys(patch) as Array<keyof ToolsState>).every((key) => tools[key] === patch[key])
      ? tools
      : { ...tools, ...patch }
}
