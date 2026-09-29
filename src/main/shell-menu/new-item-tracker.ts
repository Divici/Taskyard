import type { DesktopChange, NewItemPlacement } from '@shared/ipc'
import type { Point } from '@shared/schema'

/**
 * Native menus, Phase 3: after the Desktop background menu's New ▸ or Paste ran in the helper,
 * the item(s) it made belong at the right-click point, and a new folder or file opens inline
 * rename there — as on the real desktop. The watcher reports them a few hundred ms later
 * (awaitWriteFinish + debounce), so main arms an expectation when the helper answers `invoked`
 * and tags the next desktop:changed that brings genuinely new items in the user's Desktop folder
 * (`placeAt`). The window of that display places them (like an Explorer drop) and renames.
 */

/** How long after the command an item still counts as its result. */
export const NEW_ITEM_WINDOW_MS = 3_000

export interface NewItemExpectation {
  displayId: number
  /** The right-click point, in that window's CSS pixels. */
  point: Point
  /** New ▸ Folder / a ShellNew file: one item, renamed inline. Paste: every item, no rename. */
  rename: boolean
}

export interface NewItemTracker {
  expect(expectation: NewItemExpectation): void
  /**
   * Every desktop:changed goes through here (it also learns which ids exist, so a rescan that
   * lists everything as added places nothing). Returns the change itself when nothing is tagged.
   */
  annotate(change: DesktopChange): DesktopChange
}

export interface NewItemTrackerDeps {
  /** The user's Desktop folder (New ▸ and Paste on the Desktop background write there). */
  userDesktop: string
  now?: () => number
  windowMs?: number
}

/** Case- and slash-insensitive form of a folder path, without a trailing separator. */
function folderKey(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toUpperCase()
}

function parentKey(path: string): string {
  const normal = path.replace(/\//g, '\\')
  const cut = normal.lastIndexOf('\\')
  return folderKey(cut < 0 ? '' : normal.slice(0, cut))
}

export function createNewItemTracker(deps: NewItemTrackerDeps): NewItemTracker {
  const now = deps.now ?? Date.now
  const windowMs = deps.windowMs ?? NEW_ITEM_WINDOW_MS
  const desktop = folderKey(deps.userDesktop)
  const known = new Set<string>()
  let pending: (NewItemExpectation & { until: number }) | null = null

  return {
    expect(expectation) {
      pending = { ...expectation, point: { ...expectation.point }, until: now() + windowMs }
    },

    annotate(change) {
      const fresh = change.added.filter(
        (item) => !known.has(item.id) && parentKey(item.path) === desktop
      )
      for (const item of change.added) known.add(item.id)
      for (const item of change.changed) known.add(item.id)
      for (const id of change.removed) known.delete(id)

      if (pending !== null && now() > pending.until) pending = null
      if (pending === null || fresh.length === 0) return change

      const placeAt: NewItemPlacement = {
        displayId: pending.displayId,
        point: { ...pending.point },
        ids: fresh.map((item) => item.id),
        renameId: pending.rename ? fresh[0].id : null
      }
      // One New ▸ command makes one item; a paste may arrive in several batches.
      if (pending.rename) pending = null
      return { ...change, placeAt }
    }
  }
}
