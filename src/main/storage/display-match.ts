import { basename } from 'node:path'
import { newDisplayLayout } from '@shared/defaults'
import { clampRect, localWorkArea, rectsIntersect, type Size } from '@shared/geometry'
import { looseCell } from '@shared/group-metrics'
import { placeNewItems, type PresentItem } from '@shared/placement'
import type {
  DisplayLayout,
  Group,
  LayoutFile,
  ParkedDisplay,
  Rect,
  SettingsFile
} from '@shared/schema'

// Resilient multi-display restore (Phase 11). Electron display ids are not stable across
// reboots, driver updates or re-plugging, so each saved layout entry is matched to a current
// display in this order: the same id; else the same bounds (size AND position, so two identical
// monitors never swap); else the same size; else the primary display. Entries that land on a
// display they were not saved for (a monitor that is gone) have their groups clamped into the
// work area and stepped 24 px at a time until they overlap nothing, and their loose icons placed
// in free cells. Main is the one writer (it runs before the windows exist and after displays
// change), so two windows never move the same group twice.

/** What main knows about a connected display (a slice of Electron's `Display`). */
export interface ScreenDisplay {
  id: number
  bounds: Rect
  workArea: Rect
}

export type MatchKind = 'id' | 'position' | 'size' | 'primary'

export interface DisplayMatch {
  displayId: number
  by: MatchKind
}

/** A moved group steps this far (down and right) until it overlaps nothing. */
export const DEOVERLAP_STEP = 24

/** Displays change in bursts (and a sleeping monitor may drop out briefly): wait this long. */
export const DISPLAY_SETTLE_MS = 2_000

/** Give up stepping after this many tries (a crowded display). */
const MAX_STEPS = 200

const sameSize = (a: Rect, b: Rect): boolean => a.width === b.width && a.height === b.height
const samePosition = (a: Rect, b: Rect): boolean => a.x === b.x && a.y === b.y
const sameRect = (a: Rect, b: Rect): boolean => sameSize(a, b) && samePosition(a, b)

/** An entry with nothing placed on it: a window registered it, nothing to move. */
function isBlank(entry: DisplayLayout): boolean {
  return entry.groups.length === 0 && Object.keys(entry.loose).length === 0
}

/**
 * The current display for each saved entry (same order as `saved`). An entry only claims its
 * display (so no later entry can take it by position or size) when it holds something: an empty
 * entry for a re-plugged monitor must not hide that monitor's real, older entry.
 */
export function matchDisplays(
  saved: readonly DisplayLayout[],
  current: readonly ScreenDisplay[],
  primaryId: number
): DisplayMatch[] {
  const result: Array<DisplayMatch | null> = saved.map(() => null)
  const claimed = new Set<number>()

  saved.forEach((entry, index) => {
    if (!current.some((display) => display.id === entry.displayId)) return
    result[index] = { displayId: entry.displayId, by: 'id' }
    if (!isBlank(entry)) claimed.add(entry.displayId)
  })

  const pass = (
    by: MatchKind,
    fits: (entry: DisplayLayout, display: ScreenDisplay) => boolean
  ): void => {
    saved.forEach((entry, index) => {
      if (result[index] !== null) return
      const display = current.find((d) => !claimed.has(d.id) && fits(entry, d))
      if (!display) return
      result[index] = { displayId: display.id, by }
      claimed.add(display.id)
    })
  }
  pass('position', (entry, display) => sameRect(entry.bounds, display.bounds))
  pass('size', (entry, display) => sameSize(entry.bounds, display.bounds))

  return result.map((match) => match ?? { displayId: primaryId, by: 'primary' })
}

/**
 * `rect` clamped into `area`, then stepped 24 px down and right until it overlaps none of
 * `others`. When the steps run into the area's corner, the first free spot on a 24 px grid
 * (row by row) is used; when there is none, the clamped rect (overlapping) is returned.
 */
export function deOverlap(
  rect: Rect,
  others: readonly Rect[],
  area: Rect,
  step = DEOVERLAP_STEP
): Rect {
  const clear = (candidate: Rect): boolean => !others.some((o) => rectsIntersect(candidate, o))
  const start = clampRect(rect, area)
  let candidate = start
  for (let i = 0; i < MAX_STEPS; i++) {
    if (clear(candidate)) return candidate
    const next = clampRect({ ...candidate, x: candidate.x + step, y: candidate.y + step }, area)
    if (next.x === candidate.x && next.y === candidate.y) break
    candidate = next
  }
  for (let y = area.y; y + start.height <= area.y + area.height; y += step) {
    for (let x = area.x; x + start.width <= area.x + area.width; x += step) {
      const spot = { ...start, x, y }
      if (clear(spot)) return spot
    }
  }
  return start
}

const groupRect = (group: Group): Rect => ({
  x: group.x,
  y: group.y,
  width: group.w,
  height: group.h
})

/** `moved` appended to `target` (in z order), each clamped, de-overlapped and on top. */
function mergeGroups(target: DisplayLayout, moved: readonly Group[], area: Rect): DisplayLayout {
  if (moved.length === 0) return target
  const groups = [...target.groups]
  let top = groups.reduce((max, group) => Math.max(max, group.z), 0)
  for (const group of [...moved].sort((a, b) => a.z - b.z)) {
    if (groups.some((existing) => existing.id === group.id)) continue
    const rect = deOverlap(groupRect(group), groups.map(groupRect), area)
    top += 1
    groups.push({ ...group, x: rect.x, y: rect.y, w: rect.width, h: rect.height, z: top })
  }
  return { ...target, groups }
}

export interface RematchOptions {
  /** The loose icon cell (Settings › icon size), for placing a removed display's icons. */
  cell: Size
  /**
   * Move (and park) the entries of monitors that are not connected. False at start-up, before
   * the displays have settled: a monitor that enumerates late must not lose its layout.
   */
  park?: boolean
}

/**
 * Every parked monitor that is back restored (`restoreParked`), then every entry on a current
 * display (see `matchDisplays`). An entry matched by id, position or size keeps
 * everything and takes the display's current id and bounds. With `park` (the default), an entry
 * whose monitor is gone is parked in `parked` as it was, and copies of its groups (clamped,
 * de-overlapped, on top) and its loose icons (free cells) are shown on its display; without it
 * the entry is left alone. Displays with no entry are left to the windows (`ensureDisplay`).
 * Same object when nothing changes.
 */
export function rematchLayout(
  layout: LayoutFile,
  current: readonly ScreenDisplay[],
  primaryId: number,
  { cell, park = true }: RematchOptions
): LayoutFile {
  // Monitors that came back are restored first, so a host that goes away in the same pass never
  // hands a guest's copies to the guest's own display; then once more for anything that became
  // restorable while entries were re-matched or parked.
  const restored = restoreParked(layout, current)
  return restoreParked(placeEntries(restored, current, primaryId, cell, park), current)
}

function placeEntries(
  layout: LayoutFile,
  current: readonly ScreenDisplay[],
  primaryId: number,
  cell: Size,
  park: boolean
): LayoutFile {
  const matches = matchDisplays(layout.displays, current, primaryId)
  const leftAlone = (index: number): boolean => matches[index].by === 'primary' && !park
  const unchanged = layout.displays.every((entry, index) => {
    if (leftAlone(index)) return true
    const display = current.find((d) => d.id === entry.displayId)
    return (
      matches[index].by === 'id' && display !== undefined && sameRect(display.bounds, entry.bounds)
    )
  })
  if (unchanged) return layout

  // The entry each display keeps (best match first), and what moves onto it.
  const rank: Record<MatchKind, number> = { id: 0, position: 1, size: 2, primary: 3 }
  const byDisplay = new Map<number, number[]>()
  matches.forEach((match, index) => {
    if (leftAlone(index)) return
    byDisplay.set(match.displayId, [...(byDisplay.get(match.displayId) ?? []), index])
  })

  const built = new Map<number, DisplayLayout>()
  const moveLoose = new Map<number, string[]>()
  const parked: ParkedDisplay[] = [...(layout.parked ?? [])]
  for (const [displayId, indexes] of byDisplay) {
    const display = current.find((d) => d.id === displayId)!
    const candidates = indexes
      .filter((index) => !isBlank(layout.displays[index]))
      .sort((a, b) => rank[matches[a].by] - rank[matches[b].by] || a - b)
    const blankOwn = indexes.find((index) => isBlank(layout.displays[index]))
    const keeperIndex = candidates.find((index) => matches[index].by !== 'primary')
    const keeper =
      keeperIndex !== undefined
        ? layout.displays[keeperIndex]
        : blankOwn !== undefined
          ? layout.displays[blankOwn]
          : newDisplayLayout(displayId, display.bounds, layout.displays[candidates[0]]?.tools)
    let entry: DisplayLayout = { ...keeper, displayId, bounds: { ...display.bounds } }

    const movers = candidates.filter((index) => index !== keeperIndex)
    const area = localWorkArea(display)
    // A display that goes away while it hosts copies of another parked monitor ("guests") hands
    // them on: the guests' copies move here with its own groups, their parked records now name
    // this display as host, and its own parked entry holds only its own groups and icons. So a
    // group id is never both in a host's snapshot and in its owner's entry.
    for (const index of indexes) {
      if (matches[index].by !== 'primary' || index === keeperIndex) continue
      const gone = layout.displays[index].displayId
      parked.forEach((record, i) => {
        if (record.hostDisplayId === gone) {
          parked[i] = { ...record, hostDisplayId: displayId }
        }
      })
    }
    for (const index of movers) {
      const mover = layout.displays[index]
      const guests = (layout.parked ?? []).filter(
        (record) => record.hostDisplayId === mover.displayId
      )
      const guestGroups = new Set(guests.flatMap((record) => record.groupIds))
      const guestLoose = new Set(guests.flatMap((record) => record.looseIds))
      const before = new Set(entry.groups.map((group) => group.id))
      entry = mergeGroups(entry, mover.groups, area)
      const loose = Object.keys(mover.loose)
      if (loose.length > 0)
        moveLoose.set(displayId, [...(moveLoose.get(displayId) ?? []), ...loose])
      const ownGroups = mover.groups.filter((group) => !guestGroups.has(group.id))
      const ownLoose = Object.fromEntries(
        Object.entries(mover.loose).filter(([id]) => !guestLoose.has(id))
      )
      // Only guests' copies on it: nothing of its own to bring back.
      if (ownGroups.length === 0 && Object.keys(ownLoose).length === 0) continue
      parked.push({
        entry: { ...mover, groups: ownGroups, loose: ownLoose },
        hostDisplayId: displayId,
        groupIds: ownGroups.filter((group) => !before.has(group.id)).map((group) => group.id),
        looseIds: Object.keys(ownLoose)
      })
    }
    built.set(displayId, entry)
  }

  // Keep the file's order: each display where its first entry was; entries left alone stay.
  const displays: DisplayLayout[] = []
  const emitted = new Set<number>()
  layout.displays.forEach((entry, index) => {
    if (leftAlone(index)) {
      displays.push(entry)
      return
    }
    const id = matches[index].displayId
    if (emitted.has(id)) return
    emitted.add(id)
    displays.push(built.get(id)!)
  })
  let next: LayoutFile = { ...layout, displays }
  const parkedChanged =
    parked.length !== (layout.parked?.length ?? 0) ||
    parked.some((record, i) => record !== layout.parked?.[i])
  if (parkedChanged) next = { ...next, parked }

  for (const [displayId, ids] of moveLoose) {
    const display = current.find((d) => d.id === displayId)!
    const items: PresentItem[] = ids.map((id) => {
      const path = layout.paths[id] ?? id
      return { id, path, name: basename(path) }
    })
    // The paths stay as they were (placeNewItems would record the stand-in for an unknown one).
    const placed = placeNewItems(next, items, { displayId, area: localWorkArea(display), cell })
    next = { ...placed, paths: layout.paths }
  }
  return next
}

/**
 * Restores every parked monitor that is connected again, matched like any entry (same id, else
 * same bounds, else same size) to a display that has no entry of its own yet (or only the empty
 * one its window registered). The original groups come back where they were, keeping what the
 * user changed on their copies (title, items, sort…) and staying deleted if a copy was deleted;
 * loose icons still loose on the host go back to their old cells. The copies leave the host.
 * Same object when nothing is restored.
 */
export function restoreParked(layout: LayoutFile, current: readonly ScreenDisplay[]): LayoutFile {
  const parked = layout.parked ?? []
  if (parked.length === 0) return layout
  const free = (display: ScreenDisplay): boolean => {
    const own = layout.displays.find((entry) => entry.displayId === display.id)
    return own === undefined || isBlank(own)
  }
  const claimed = new Set<number>()
  const target = parked.map((): ScreenDisplay | null => null)
  const pass = (fits: (entry: DisplayLayout, display: ScreenDisplay) => boolean): void => {
    parked.forEach((p, index) => {
      if (target[index] !== null) return
      const display = current.find((d) => !claimed.has(d.id) && free(d) && fits(p.entry, d))
      if (!display) return
      target[index] = display
      claimed.add(display.id)
    })
  }
  pass((entry, display) => entry.displayId === display.id)
  pass((entry, display) => sameRect(entry.bounds, display.bounds))
  pass((entry, display) => sameSize(entry.bounds, display.bounds))
  if (target.every((display) => display === null)) return layout

  let displays = layout.displays
  const stillParked: ParkedDisplay[] = []
  parked.forEach((p, index) => {
    const display = target[index]
    if (display === null) {
      stillParked.push(p)
      return
    }
    const hostIndex = displays.findIndex((entry) => entry.displayId === p.hostDisplayId)
    let restored: DisplayLayout
    if (hostIndex === -1) {
      // The host is gone too: nothing was edited there that we could know about.
      restored = { ...p.entry }
    } else {
      const host = displays[hostIndex]
      const copies = new Map(
        host.groups.filter((group) => p.groupIds.includes(group.id)).map((g) => [g.id, g])
      )
      const takenBack = p.looseIds.filter((id) => host.loose[id] !== undefined)
      const hostLoose = { ...host.loose }
      for (const id of takenBack) delete hostLoose[id]
      displays = displays.map((entry, i) =>
        i === hostIndex
          ? { ...host, groups: host.groups.filter((g) => !copies.has(g.id)), loose: hostLoose }
          : entry
      )
      const groups = p.entry.groups.flatMap((original) => {
        const copy = copies.get(original.id)
        if (!copy) return []
        const { x, y, w, h, z } = original
        return [{ ...copy, x, y, w, h, z }]
      })
      const loose = Object.fromEntries(
        Object.entries(p.entry.loose).filter(([id]) =>
          p.looseIds.includes(id) ? takenBack.includes(id) : true
        )
      )
      restored = { ...p.entry, groups, loose }
    }
    restored = { ...restored, displayId: display.id, bounds: { ...display.bounds } }
    const own = displays.findIndex((entry) => entry.displayId === display.id)
    displays =
      own === -1
        ? [...displays, restored]
        : displays.map((entry, i) => (i === own ? restored : entry))
  })

  const next: LayoutFile = { ...layout, displays }
  if (stillParked.length > 0) next.parked = stillParked
  else delete next.parked
  return next
}

export interface DisplayMatchingDeps {
  screen: {
    getAllDisplays(): ScreenDisplay[]
    getPrimaryDisplay(): ScreenDisplay
    on(
      event: 'display-added' | 'display-removed' | 'display-metrics-changed',
      listener: () => void
    ): unknown
    removeListener(
      event: 'display-added' | 'display-removed' | 'display-metrics-changed',
      listener: () => void
    ): unknown
  }
  storage: {
    layout: { get(): LayoutFile; save(data: LayoutFile): unknown }
    settings: { get(): Pick<SettingsFile, 'iconSize'> }
  }
  log: { info(message: string): void; error(message: string, error: unknown): void }
  settleMs?: number
}

const EVENTS = ['display-added', 'display-removed', 'display-metrics-changed'] as const

/**
 * Re-matches the saved layout to the connected displays: at once without parking (call it before
 * the desktop windows register theirs), then fully once the displays have settled, and again
 * every time they settle after a change. Returns the stop.
 */
export function startDisplayMatching(deps: DisplayMatchingDeps): () => void {
  const { screen, storage, log, settleMs = DISPLAY_SETTLE_MS } = deps
  let timer: ReturnType<typeof setTimeout> | null = null

  const run = (park: boolean): void => {
    try {
      const layout = storage.layout.get()
      const current = screen.getAllDisplays()
      const primaryId = screen.getPrimaryDisplay().id
      const cell = looseCell(storage.settings.get().iconSize)
      const next = rematchLayout(layout, current, primaryId, { cell, park })
      if (next === layout) return
      const matches = matchDisplays(layout.displays, current, primaryId)
      const moves = layout.displays
        .map((entry, index) => ({ entry, match: matches[index] }))
        .filter(({ match }) => park || match.by !== 'primary')
        .filter(({ entry, match }) => match.by !== 'id' || entry.displayId !== match.displayId)
        .map(({ entry, match }) => `display ${entry.displayId} → ${match.displayId} (${match.by})`)
      const restored = (layout.parked ?? []).length - (next.parked ?? []).length
      const parkedNow = (next.parked ?? []).length - (layout.parked ?? []).length
      const notes = [
        ...moves,
        ...(parkedNow > 0 ? [`${parkedNow} parked`] : []),
        ...(restored > 0 ? [`${restored} restored`] : [])
      ]
      log.info(
        `displays: re-matched the layout${notes.length ? `: ${notes.join(', ')}` : ' (bounds)'}`
      )
      storage.layout.save(next)
    } catch (error) {
      // A failed match must never stop the start-up or a display event.
      log.error('displays: re-matching failed', error)
    }
  }

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      run(true)
    }, settleMs)
  }

  // Start-up: re-id what is connected now (before the windows register their displays), but move
  // nothing off a monitor that may still be enumerating; the full match waits for the settle.
  run(false)
  schedule()
  for (const event of EVENTS) screen.on(event, schedule)
  return () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    for (const event of EVENTS) screen.removeListener(event, schedule)
  }
}
