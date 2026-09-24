import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  defaultTimer,
  emptyLayout,
  emptyTasks,
  newDisplayLayout
} from '@shared/defaults'
import { LayoutFileSchema, SettingsFileSchema, TasksFileSchema, type Group } from '@shared/schema'
import { parseExact } from './exact-parse'

const group: Group = {
  id: 'g-1',
  title: 'Apps',
  x: 40,
  y: 40,
  w: 280,
  h: 200,
  z: 1,
  rolledUp: false,
  items: ['1:2'],
  sort: 'manual',
  excludeFromQuickHide: false,
  createdAt: 1
}

function layout(): ReturnType<typeof emptyLayout> {
  const display = newDisplayLayout(1, { x: 0, y: 0, width: 2560, height: 1440 })
  return { ...emptyLayout(), displays: [{ ...display, groups: [group] }] }
}

function without<T extends object>(value: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...value }
  delete copy[key]
  return copy
}

describe('parseExact', () => {
  it('accepts a complete file and returns it unchanged', () => {
    const input = layout()

    expect(parseExact(LayoutFileSchema, input)).toEqual({ success: true, data: input })
  })

  it('rejects a display that is missing its tools instead of filling the default', () => {
    const input = layout()
    const partial = { ...input, displays: [without(input.displays[0], 'tools')] }

    expect(parseExact(LayoutFileSchema, partial)).toEqual({
      success: false,
      error: 'displays.0.tools: missing (the file would silently take a default)'
    })
  })

  it('rejects a group that is missing its items', () => {
    const input = layout()
    const display = { ...input.displays[0], groups: [without(group, 'items')] }

    expect(parseExact(LayoutFileSchema, { ...input, displays: [display] })).toMatchObject({
      success: false,
      error: expect.stringMatching(/^displays\.0\.groups\.0\.items: missing/)
    })
  })

  it('rejects an unknown key at any depth', () => {
    const input = layout()
    const display = { ...input.displays[0], groups: [{ ...group, color: 'red' }] }

    expect(parseExact(LayoutFileSchema, { ...input, displays: [display] })).toEqual({
      success: false,
      error: 'displays.0.groups.0.color: unknown key'
    })
  })

  it('rejects a partial settings file and a timer without its presets', () => {
    expect(parseExact(SettingsFileSchema, without(defaultSettings(), 'glow'))).toMatchObject({
      success: false,
      error: expect.stringMatching(/^glow: missing/)
    })
    const tasks = { ...emptyTasks(), timer: without(defaultTimer(), 'presetsMs') }
    expect(parseExact(TasksFileSchema, tasks)).toMatchObject({
      success: false,
      error: expect.stringMatching(/^timer\.presetsMs: missing/)
    })
  })

  it('accepts optional fields that are absent', () => {
    const tasks = {
      ...emptyTasks(),
      tasks: [{ id: 't', text: 'Plan', done: false, order: 0, createdAt: 1 }]
    }

    expect(parseExact(TasksFileSchema, tasks)).toEqual({ success: true, data: tasks })
  })

  it('reports ordinary schema errors with their path', () => {
    const input = layout()
    const display = { ...input.displays[0], groups: [{ ...group, w: -1 }] }

    expect(parseExact(LayoutFileSchema, { ...input, displays: [display] })).toMatchObject({
      success: false,
      error: expect.stringContaining('displays.0.groups.0.w')
    })
  })
})
