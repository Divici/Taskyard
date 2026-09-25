import { newDisplayLayout, emptyLayout } from '@shared/defaults'
import type { DisplayInfo } from '@shared/ipc'
import type { DesktopItem, Group, LayoutFile } from '@shared/schema'
import { useDisplayStore } from '../stores/display'
import { useItemsStore } from '../stores/items'
import { useLayoutStore } from '../stores/layout'
import { useSettingsStore } from '../stores/settings'
import { defaultSettings } from '@shared/defaults'
import type { SettingsFile } from '@shared/schema'

/** The fake bridge's primary display (2560×1440 at 150 %, 48 px taskbar at the bottom). */
export const PRIMARY_INFO: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1392 },
  scaleFactor: 1.5
}

export function desktopItem(
  id: string,
  name: string,
  patch: Partial<DesktopItem> = {}
): DesktopItem {
  const ext = patch.ext ?? (patch.kind === 'folder' ? '' : '.txt')
  return {
    id,
    path: `C:\\Users\\me\\Desktop\\${name}${ext}`,
    name,
    ext,
    kind: 'file',
    mtimeMs: 1,
    sizeBytes: 1,
    readonly: false,
    placeholder: false,
    ...patch
  }
}

export function makeGroup(id: string, patch: Partial<Group> = {}): Group {
  return {
    id,
    title: 'Work',
    x: 40,
    y: 40,
    w: 280,
    h: 200,
    z: 1,
    rolledUp: false,
    items: [],
    sort: 'manual',
    excludeFromQuickHide: false,
    createdAt: 1,
    ...patch
  }
}

export interface SeedOptions {
  items?: DesktopItem[]
  groups?: Group[]
  loose?: Record<string, { x: number; y: number }>
  settings?: Partial<SettingsFile>
  display?: DisplayInfo
}

/**
 * Hydrates the stores the canvas reads, without a bridge round-trip: the display, the items, the
 * layout (one display entry) and the settings. Saves still go to whatever bridge is installed.
 */
export function seedCanvas({
  items = [],
  groups = [],
  loose = {},
  settings = {},
  display = PRIMARY_INFO
}: SeedOptions = {}): LayoutFile {
  const layout: LayoutFile = {
    ...emptyLayout(),
    displays: [{ ...newDisplayLayout(display.id, display.bounds), groups, loose }],
    paths: Object.fromEntries(items.map((item) => [item.id, item.path]))
  }
  useDisplayStore.getState().setDisplayId(display.id)
  useDisplayStore.getState().receiveInfo(display)
  useSettingsStore.getState().receive({ revision: 1, data: { ...defaultSettings(), ...settings } })
  useLayoutStore.getState().receive({ revision: 1, data: layout })
  useItemsStore.getState().hydrate(items)
  return layout
}
