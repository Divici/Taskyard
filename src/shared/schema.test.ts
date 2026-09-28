import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  DEFAULT_TIMER,
  DEFAULT_TOOLS,
  emptyJournal,
  emptyLayout,
  emptyTasks,
  newDisplayLayout,
  TIMER_PRESETS_MS
} from './defaults'
import {
  DesktopItemSchema,
  FILE_ID_PATTERN,
  GroupSchema,
  LayoutFileSchema,
  MoveOpSchema,
  OpsJournalSchema,
  SettingsFileSchema,
  TasksFileSchema,
  TaskSchema,
  TimerStateSchema,
  type SettingsFile
} from './schema'

const item = {
  id: '2891234567:1125899906842721',
  path: 'C:\\Users\\me\\Desktop\\Notes.txt',
  name: 'Notes',
  ext: '.txt',
  kind: 'file',
  mtimeMs: 1_758_600_000_000.25,
  sizeBytes: 1024,
  readonly: false,
  placeholder: false
} as const

const group = {
  id: 'g-1',
  title: 'Apps',
  x: 40,
  y: 32,
  w: 280,
  h: 200,
  z: 1,
  rolledUp: false,
  items: ['1:2', '1:3'],
  sort: 'manual',
  excludeFromQuickHide: false,
  createdAt: 1_758_600_000_000
} as const

describe('DesktopItemSchema', () => {
  it('accepts a well-formed item', () => {
    expect(DesktopItemSchema.parse(item)).toEqual(item)
  })

  it('rejects a negative size', () => {
    const result = DesktopItemSchema.safeParse({ ...item, sizeBytes: -1 })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['sizeBytes'])
  })

  it.each(['12345', '12:ab', ':1', '1:', '1:2:3', ' 1:2', '0x1:2', '-1:2'])(
    'rejects id %j, which is not `${dev}:${ino}`',
    (id) => {
      const result = DesktopItemSchema.safeParse({ ...item, id })

      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.path).toEqual(['id'])
    }
  )

  it('matches file ids against ^\\d+:\\d+$', () => {
    expect(FILE_ID_PATTERN.source).toBe('^\\d+:\\d+$')
    expect(FILE_ID_PATTERN.test('0:0')).toBe(true)
  })

  it('rejects an unknown kind', () => {
    expect(DesktopItemSchema.safeParse({ ...item, kind: 'shortcut' }).success).toBe(false)
  })

  it('keeps optional targetPath and url', () => {
    const link = { ...item, kind: 'url', url: 'https://example.com', targetPath: 'C:\\x.exe' }

    expect(DesktopItemSchema.parse(link)).toEqual(link)
  })
})

describe('GroupSchema', () => {
  it('accepts a group whose items are file ids', () => {
    expect(GroupSchema.parse(group)).toEqual(group)
  })

  it('rejects a member that is not a file id', () => {
    expect(GroupSchema.safeParse({ ...group, items: ['C:\\x.txt'] }).success).toBe(false)
  })

  it('rejects a zero or negative size', () => {
    expect(GroupSchema.safeParse({ ...group, w: 0 }).success).toBe(false)
    expect(GroupSchema.safeParse({ ...group, h: -5 }).success).toBe(false)
  })

  it('rejects an unknown sort', () => {
    expect(GroupSchema.safeParse({ ...group, sort: 'size' }).success).toBe(false)
  })
})

describe('LayoutFileSchema', () => {
  const display = newDisplayLayout(2528732444, { x: 0, y: 0, width: 2560, height: 1440 })

  it('accepts version 1 with displays, top-level paths and lastSeen', () => {
    const layout = {
      version: 1,
      displays: [{ ...display, groups: [group], loose: { '1:9': { x: 8, y: 8 } } }],
      paths: { '1:2': 'C:\\Users\\me\\Desktop\\a.lnk' },
      lastSeen: { '1:3': 1_758_600_000_000 }
    }

    expect(LayoutFileSchema.parse(layout)).toEqual(layout)
  })

  it('rejects any other version', () => {
    expect(LayoutFileSchema.safeParse({ ...emptyLayout(), version: 2 }).success).toBe(false)
  })

  it('rejects loose, paths and lastSeen keys that are not file ids', () => {
    const bad = (patch: object): boolean =>
      LayoutFileSchema.safeParse({ ...emptyLayout(), ...patch }).success

    expect(bad({ displays: [{ ...display, loose: { 'C:\\a.txt': { x: 1, y: 1 } } }] })).toBe(false)
    expect(bad({ paths: { 'a.txt': 'C:\\a.txt' } })).toBe(false)
    expect(bad({ lastSeen: { nope: 1 } })).toBe(false)
  })

  it('fills a display with default groups, loose and tools', () => {
    const parsed = LayoutFileSchema.parse({
      version: 1,
      displays: [{ displayId: 7, bounds: { x: 2560, y: 0, width: 1920, height: 1080 } }]
    })

    expect(parsed.displays[0]).toEqual({
      displayId: 7,
      bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
      groups: [],
      loose: {},
      tools: DEFAULT_TOOLS
    })
    expect(parsed.paths).toEqual({})
    expect(parsed.lastSeen).toEqual({})
  })

  it('matches emptyLayout()', () => {
    expect(LayoutFileSchema.parse({ version: 1 })).toEqual(emptyLayout())
  })

  it('Phase 11: keeps parked displays (a monitor that went away), optional for older files', () => {
    const parked = [
      {
        entry: { ...display, displayId: 20, groups: [group] },
        hostDisplayId: 2528732444,
        groupIds: [group.id],
        looseIds: ['1:9']
      }
    ]
    const layout = { ...emptyLayout(), parked }
    expect(LayoutFileSchema.parse(layout)).toEqual(layout)
    expect(LayoutFileSchema.parse({ version: 1 }).parked).toBeUndefined()
    expect(
      LayoutFileSchema.safeParse({ ...emptyLayout(), parked: [{ ...parked[0], looseIds: ['x'] }] })
        .success
    ).toBe(false)
  })
})

describe('TasksFileSchema', () => {
  const task = { id: 't-1', text: 'Ship Phase 3', done: false, order: 0, createdAt: 1 }

  it('defaults to no tasks and an idle timer with the four presets', () => {
    expect(TasksFileSchema.parse({ version: 1 })).toEqual(emptyTasks())
    expect(emptyTasks().timer).toEqual(DEFAULT_TIMER)
    expect(DEFAULT_TIMER.presetsMs).toEqual([300000, 900000, 1500000, 2700000])
    expect(TIMER_PRESETS_MS).toEqual([300000, 900000, 1500000, 2700000])
  })

  it('accepts a task and a completed task', () => {
    expect(TaskSchema.parse(task)).toEqual(task)
    const done = { ...task, done: true, completedAt: 2 }
    expect(TaskSchema.parse(done)).toEqual(done)
  })

  it('rejects empty or over-long task text', () => {
    expect(TaskSchema.safeParse({ ...task, text: '' }).success).toBe(false)
    expect(TaskSchema.safeParse({ ...task, text: 'x'.repeat(501) }).success).toBe(false)
  })

  it('requires endsAt while running and remainingMs while paused', () => {
    const base = { ...DEFAULT_TIMER }

    expect(TimerStateSchema.safeParse({ ...base, status: 'running' }).success).toBe(false)
    expect(
      TimerStateSchema.safeParse({ ...base, status: 'running', endsAt: 1_758_600_000_000 }).success
    ).toBe(true)
    expect(TimerStateSchema.safeParse({ ...base, status: 'paused' }).success).toBe(false)
    expect(
      TimerStateSchema.safeParse({ ...base, status: 'paused', remainingMs: 60_000 }).success
    ).toBe(true)
  })

  it('rejects a non-positive duration', () => {
    expect(TimerStateSchema.safeParse({ ...DEFAULT_TIMER, durationMs: 0 }).success).toBe(false)
  })
})

describe('SettingsFileSchema', () => {
  it('fills every setting with its default', () => {
    expect(SettingsFileSchema.parse({ version: 1 })).toEqual({
      version: 1,
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
      reduceMotion: false
    })
    expect(SettingsFileSchema.parse({ version: 1 })).toEqual(defaultSettings())
  })

  it('Phase 12: a settings file written before reduceMotion existed keeps motion on', () => {
    const before: Partial<SettingsFile> = defaultSettings()
    delete before.reduceMotion
    expect(SettingsFileSchema.parse(before).reduceMotion).toBe(false)
    expect(SettingsFileSchema.parse({ ...before, reduceMotion: true }).reduceMotion).toBe(true)
  })

  it('bounds glassOpacity to 0–100 and glassBlur to 0–40', () => {
    const parse = (patch: object): boolean =>
      SettingsFileSchema.safeParse({ ...defaultSettings(), ...patch }).success

    expect(parse({ glassOpacity: 0 })).toBe(true)
    expect(parse({ glassOpacity: 100 })).toBe(true)
    expect(parse({ glassOpacity: 101 })).toBe(false)
    expect(parse({ glassOpacity: -1 })).toBe(false)
    expect(parse({ glassBlur: 40 })).toBe(true)
    expect(parse({ glassBlur: 41 })).toBe(false)
  })

  it('rejects values outside the theme, accent and iconSize enums', () => {
    const parse = (patch: object): boolean =>
      SettingsFileSchema.safeParse({ ...defaultSettings(), ...patch }).success

    expect(parse({ theme: 'auto' })).toBe(false)
    expect(parse({ accent: 'green' })).toBe(false)
    expect(parse({ iconSize: 'huge' })).toBe(false)
  })

  it('returns a fresh object from defaultSettings()', () => {
    expect(defaultSettings()).not.toBe(defaultSettings())
  })
})

describe('OpsJournalSchema', () => {
  const op = { token: 'tok-1', from: 'D:\\a.txt', to: 'C:\\Desktop\\a.txt', state: 'pending' }

  it('accepts the four move states', () => {
    for (const state of ['pending', 'copied', 'done', 'undone']) {
      expect(MoveOpSchema.safeParse({ ...op, state }).success).toBe(true)
    }
    expect(MoveOpSchema.safeParse({ ...op, state: 'moving' }).success).toBe(false)
  })

  it('defaults to an empty op list', () => {
    expect(OpsJournalSchema.parse({ version: 1 })).toEqual(emptyJournal())
    expect(emptyJournal()).toEqual({ version: 1, ops: [] })
  })
})
