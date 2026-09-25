import { z } from 'zod'
import { SETTINGS_VALUES, TIMER_DEFAULT_MS, TIMER_PRESETS_MS, TOOLS_VALUES } from './defaults'
import { SCHEMA_VERSION } from './version'

/**
 * Persisted data shapes. Every file carries `version`; migrations.ts upgrades older files and a
 * newer version puts the file in read-only mode. Field defaults let an older file of the same
 * version gain new optional fields without a version bump.
 */
export { SCHEMA_VERSION }

// ---------------------------------------------------------------------------------------------
// Desktop items

/** `${dev}:${ino}` from `fs.stat(path, { bigint: true })`: volume serial + NTFS file index. */
export const FILE_ID_PATTERN = /^\d+:\d+$/

export const FileIdSchema = z.string().regex(FILE_ID_PATTERN, 'expected a `${dev}:${ino}` file id')

export const ItemKindSchema = z.enum(['app', 'file', 'folder', 'link', 'url'])

export const DesktopItemSchema = z.object({
  id: FileIdSchema,
  path: z.string().min(1),
  name: z.string(),
  ext: z.string(),
  kind: ItemKindSchema,
  mtimeMs: z.number(),
  sizeBytes: z.number().int().nonnegative(),
  readonly: z.boolean(),
  placeholder: z.boolean(),
  /** Shortcut target (`.lnk`), as recorded in the link; never touched to find it. */
  targetPath: z.string().optional(),
  /** The target is on the network (UNC, or a mapped drive): never extract icons from it. */
  targetRemote: z.boolean().optional(),
  /** `.url` address. */
  url: z.string().optional(),
  /** Icon file named by the shortcut (IconLocation / IconFile), environment expanded. */
  iconPath: z.string().optional(),
  /** Icon index in `iconPath` (or the target); negative = resource id. */
  iconIndex: z.number().int().optional()
})

// ---------------------------------------------------------------------------------------------
// Layout

export const PointSchema = z.object({ x: z.number(), y: z.number() })

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative()
})

export const GroupSortSchema = z.enum(['manual', 'name', 'type', 'modified'])

export const GroupSchema = z.object({
  id: z.string().min(1),
  title: z.string().max(255),
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  z: z.number().int(),
  rolledUp: z.boolean().default(false),
  /** Member file ids, in display order for `manual` sort. */
  items: z.array(FileIdSchema).default(() => []),
  sort: GroupSortSchema.default('manual'),
  excludeFromQuickHide: z.boolean().default(false),
  createdAt: z.number().int().nonnegative()
})

export const ToolsStateSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  rolledUp: z.boolean(),
  visible: z.boolean(),
  activeTool: z.enum(['tasks', 'timer'])
})

export const DisplayLayoutSchema = z.object({
  /** Electron `Display.id`. */
  displayId: z.number().int(),
  /** The display's bounds when last seen; used to re-match displays whose id changed. */
  bounds: RectSchema,
  groups: z.array(GroupSchema).default(() => []),
  /** Ungrouped items: file id → position. */
  loose: z.record(FileIdSchema, PointSchema).default(() => ({})),
  tools: ToolsStateSchema.default(() => ({ ...TOOLS_VALUES }))
})

export const LayoutFileSchema = z.object({
  version: z.literal(SCHEMA_VERSION),
  displays: z.array(DisplayLayoutSchema).default(() => []),
  /** File id → last known path. Top level, so a rename updates exactly one entry. */
  paths: z.record(FileIdSchema, z.string()).default(() => ({})),
  /** File id → epoch ms when the id was first found missing (pruned after 30 days). */
  lastSeen: z.record(FileIdSchema, z.number().int().nonnegative()).default(() => ({}))
})

// ---------------------------------------------------------------------------------------------
// Tasks and timer

export const TaskSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(500),
  done: z.boolean(),
  order: z.number(),
  createdAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional()
})

const MAX_TIMER_MS = 180 * 60_000

export const TimerStateSchema = z
  .object({
    status: z.enum(['idle', 'running', 'paused', 'finished']).default('idle'),
    durationMs: z.number().int().positive().max(MAX_TIMER_MS).default(TIMER_DEFAULT_MS),
    /** Absolute epoch ms, so a running timer survives sleep and restarts without drifting. */
    endsAt: z.number().int().nonnegative().optional(),
    remainingMs: z.number().int().nonnegative().optional(),
    linkedTaskId: z.string().min(1).optional(),
    presetsMs: z
      .array(z.number().int().positive().max(MAX_TIMER_MS))
      .default(() => [...TIMER_PRESETS_MS])
  })
  .superRefine((timer, ctx) => {
    if (timer.status === 'running' && timer.endsAt === undefined) {
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'a running timer needs endsAt' })
    }
    if (timer.status === 'paused' && timer.remainingMs === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['remainingMs'],
        message: 'a paused timer needs remainingMs'
      })
    }
  })

export const TasksFileSchema = z.object({
  version: z.literal(SCHEMA_VERSION),
  tasks: z.array(TaskSchema).default(() => []),
  timer: TimerStateSchema.default(() => ({
    status: 'idle' as const,
    durationMs: TIMER_DEFAULT_MS,
    presetsMs: [...TIMER_PRESETS_MS]
  }))
})

// ---------------------------------------------------------------------------------------------
// Settings

const S = SETTINGS_VALUES

export const SettingsFileSchema = z.object({
  version: z.literal(SCHEMA_VERSION),
  theme: z.enum(['system', 'dark', 'light']).default(S.theme),
  glassOpacity: z.number().min(0).max(100).default(S.glassOpacity),
  glassBlur: z.number().min(0).max(40).default(S.glassBlur),
  glow: z.boolean().default(S.glow),
  accent: z.enum(['cyan', 'blue', 'purple', 'white']).default(S.accent),
  iconSize: z.enum(['small', 'medium', 'large']).default(S.iconSize),
  showExtensions: z.boolean().default(S.showExtensions),
  quickHideOnDoubleClick: z.boolean().default(S.quickHideOnDoubleClick),
  peekShortcut: z.string().min(1).max(64).default(S.peekShortcut),
  autostart: z.boolean().default(S.autostart),
  toolsEnabled: z.boolean().default(S.toolsEnabled),
  timerSound: z.boolean().default(S.timerSound),
  timerNotify: z.boolean().default(S.timerNotify),
  gridSnap: z.boolean().default(S.gridSnap),
  firstRunDone: z.boolean().default(S.firstRunDone)
})

// ---------------------------------------------------------------------------------------------
// Move journal (ops.json)

export const MoveOpStateSchema = z.enum(['pending', 'copied', 'done', 'undone'])

export const MoveOpSchema = z.object({
  token: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  state: MoveOpStateSchema,
  /**
   * The destination's file id, recorded when the move reaches `copied`, so a rollback can report
   * it even after `to` was deleted and the app died before the journal was rewritten.
   */
  toId: FileIdSchema.optional()
})

export const OpsJournalSchema = z.object({
  version: z.literal(SCHEMA_VERSION),
  ops: z.array(MoveOpSchema).default(() => [])
})

// ---------------------------------------------------------------------------------------------

export type FileId = z.infer<typeof FileIdSchema>
export type ItemKind = z.infer<typeof ItemKindSchema>
export type DesktopItem = z.infer<typeof DesktopItemSchema>
export type Point = z.infer<typeof PointSchema>
export type Rect = z.infer<typeof RectSchema>
export type GroupSort = z.infer<typeof GroupSortSchema>
export type Group = z.infer<typeof GroupSchema>
export type ToolsState = z.infer<typeof ToolsStateSchema>
export type DisplayLayout = z.infer<typeof DisplayLayoutSchema>
export type LayoutFile = z.infer<typeof LayoutFileSchema>
export type Task = z.infer<typeof TaskSchema>
export type TimerState = z.infer<typeof TimerStateSchema>
export type TasksFile = z.infer<typeof TasksFileSchema>
export type SettingsFile = z.infer<typeof SettingsFileSchema>
export type MoveOpState = z.infer<typeof MoveOpStateSchema>
export type MoveOp = z.infer<typeof MoveOpSchema>
export type OpsJournalFile = z.infer<typeof OpsJournalSchema>
