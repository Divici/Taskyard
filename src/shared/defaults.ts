// Default values for every persisted file. Kept free of zod so the renderer can import them
// without bundling the validator. schema.ts builds its zod defaults from the raw *_VALUES below
// (typed independently of the schema, which avoids a circular type), and schema.test.ts proves
// the zod defaults and the typed constants agree.
import type {
  DisplayLayout,
  LayoutFile,
  OpsJournalFile,
  Rect,
  SettingsFile,
  TasksFile,
  TimerState,
  ToolsState
} from './schema'
import { SCHEMA_VERSION } from './version'

/** Timer presets: 5, 15, 25 and 45 minutes. */
export const TIMER_PRESETS_MS: readonly number[] = [300_000, 900_000, 1_500_000, 2_700_000]

/** A new timer is set to 25 minutes. */
export const TIMER_DEFAULT_MS = 1_500_000

/** Where a display's tools widget starts; Phase 10 may place it relative to the work area. */
export const TOOLS_VALUES = {
  x: 32,
  y: 32,
  w: 320,
  h: 400,
  rolledUp: false,
  visible: true,
  activeTool: 'tasks'
} as const

export const SETTINGS_VALUES = {
  theme: 'system',
  glassOpacity: 40,
  glassBlur: 16,
  glow: true,
  accent: 'cyan',
  iconSize: 'medium',
  showExtensions: false,
  quickHideOnDoubleClick: true,
  peekShortcut: 'Ctrl+Alt+Space',
  autostart: true,
  toolsEnabled: true,
  timerSound: true,
  timerNotify: true,
  gridSnap: true,
  firstRunDone: false,
  /** Phase 12: the motion kill switch (Settings › Behavior › Reduce motion). */
  reduceMotion: false
} as const

export const DEFAULT_TIMER: Readonly<TimerState> = {
  status: 'idle',
  durationMs: TIMER_DEFAULT_MS,
  presetsMs: [...TIMER_PRESETS_MS]
}

export const DEFAULT_TOOLS: Readonly<ToolsState> = { ...TOOLS_VALUES }

export const DEFAULT_SETTINGS: Readonly<SettingsFile> = {
  version: SCHEMA_VERSION,
  ...SETTINGS_VALUES
}

export function defaultSettings(): SettingsFile {
  return { ...DEFAULT_SETTINGS }
}

export function defaultTimer(): TimerState {
  return { ...DEFAULT_TIMER, presetsMs: [...TIMER_PRESETS_MS] }
}

export function emptyLayout(): LayoutFile {
  return { version: SCHEMA_VERSION, displays: [], paths: {}, lastSeen: {} }
}

export function emptyTasks(): TasksFile {
  return { version: SCHEMA_VERSION, tasks: [], timer: defaultTimer() }
}

export function emptyJournal(): OpsJournalFile {
  return { version: SCHEMA_VERSION, ops: [] }
}

/**
 * A display seen for the first time: no groups, no loose items, the default tools widget with
 * `tools` over it (Phase 10: where it starts and whether it shows there).
 */
export function newDisplayLayout(
  displayId: number,
  bounds: Rect,
  tools: Partial<ToolsState> = {}
): DisplayLayout {
  return {
    displayId,
    bounds: { ...bounds },
    groups: [],
    loose: {},
    tools: { ...TOOLS_VALUES, ...tools }
  }
}
