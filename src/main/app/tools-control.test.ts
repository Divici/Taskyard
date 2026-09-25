import { describe, expect, it, vi } from 'vitest'
import {
  defaultSettings,
  defaultTimer,
  emptyLayout,
  emptyTasks,
  newDisplayLayout
} from '@shared/defaults'
import type { LayoutFile, SettingsFile, TasksFile } from '@shared/schema'
import {
  setToolsVisible,
  timerStatusText,
  toggleToolsWidget,
  toolsShownAnywhere,
  type ToolsControlStorage
} from './tools-control'

const PRIMARY = { x: 0, y: 0, width: 2560, height: 1440 }
const SECONDARY = { x: 2560, y: 0, width: 1920, height: 1080 }
const NOW = 1_000_000

function layout(primaryVisible: boolean, secondaryVisible: boolean): LayoutFile {
  const a = newDisplayLayout(1, PRIMARY)
  const b = newDisplayLayout(2, SECONDARY)
  return {
    ...emptyLayout(),
    displays: [
      { ...a, tools: { ...a.tools, visible: primaryVisible } },
      { ...b, tools: { ...b.tools, visible: secondaryVisible } }
    ]
  }
}

function storage(
  start: LayoutFile,
  settings: Partial<SettingsFile> = {}
): ToolsControlStorage & {
  data: { layout: LayoutFile; settings: SettingsFile }
} {
  const data = { layout: start, settings: { ...defaultSettings(), ...settings } }
  return {
    data,
    layout: {
      get: () => data.layout,
      save: vi.fn((next: LayoutFile) => {
        data.layout = next
        return { ok: true as const, revision: 2 }
      })
    },
    settings: {
      get: () => data.settings,
      save: vi.fn((next: SettingsFile) => {
        data.settings = next
        return { ok: true as const, revision: 2 }
      })
    }
  }
}

const visibility = (file: LayoutFile): boolean[] => file.displays.map((d) => d.tools.visible)

describe('tools widget control (for the tray, Phase 11)', () => {
  it('toolsShownAnywhere needs toolsEnabled and a display showing the widget', () => {
    expect(toolsShownAnywhere(layout(false, true), defaultSettings())).toBe(true)
    expect(toolsShownAnywhere(layout(false, false), defaultSettings())).toBe(false)
    expect(
      toolsShownAnywhere(layout(true, true), { ...defaultSettings(), toolsEnabled: false })
    ).toBe(false)
  })

  it('setToolsVisible changes only the named displays and returns the same layout when nothing changes', () => {
    const start = layout(false, false)

    expect(visibility(setToolsVisible(start, true, [2]))).toEqual([false, true])
    expect(setToolsVisible(start, false, [1, 2])).toBe(start)
  })

  it('toggle hides the widget on every display when it is shown anywhere', () => {
    const store = storage(layout(true, true))

    expect(toggleToolsWidget(store, 1)).toBe(false)

    expect(visibility(store.data.layout)).toEqual([false, false])
    expect(store.settings.save).not.toHaveBeenCalled()
  })

  it('toggle shows it on the primary display (re-enabling the tools) when hidden', () => {
    const store = storage(layout(false, false), { toolsEnabled: false })

    expect(toggleToolsWidget(store, 1)).toBe(true)

    expect(visibility(store.data.layout)).toEqual([true, false])
    expect(store.data.settings.toolsEnabled).toBe(true)
  })

  it('timerStatusText gives the tray tooltip line while a timer runs or is paused', () => {
    const tasks = (patch: Partial<TasksFile['timer']>): TasksFile => ({
      ...emptyTasks(),
      timer: { ...defaultTimer(), ...patch }
    })

    expect(timerStatusText(tasks({ status: 'running', endsAt: NOW + 754_000 }), NOW)).toBe(
      'Timer 12:34 left'
    )
    expect(timerStatusText(tasks({ status: 'paused', remainingMs: 60_000 }), NOW)).toBe(
      'Timer paused at 01:00'
    )
    expect(timerStatusText(tasks({ status: 'idle' }), NOW)).toBeNull()
    expect(timerStatusText(tasks({ status: 'finished' }), NOW)).toBeNull()
  })
})
