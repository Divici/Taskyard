import { placementsOf, type ItemPlacement } from '@shared/drop-placement'
import type { DesktopErrorCode, MoveOutcome } from '@shared/ipc'
import { getBridge } from '../../lib/bridge'
import { useItemsStore } from '../../stores/items'
import { useLayoutStore } from '../../stores/layout'
import { useUiStore } from '../../stores/ui'
import { UNDO_DROP_MS } from './dnd-types'
import { dropItems, type DropPlace, type DropTarget } from './drop-actions'

// Explorer drops (Phase 8): files dropped on Taskyard move into the user's Desktop folder, like a
// drop on the Windows desktop, and land where they were dropped; a 6 s toast offers Undo.

/** Why a dropped file was not moved, per typed error code (after "name: "). */
const MOVE_FAILURES: Readonly<Record<DesktopErrorCode, string>> = {
  'not-found': 'it isn’t there any more.',
  readonly: 'Windows won’t let you move it from there.',
  exists: 'an item with that name is already on the Desktop.',
  permission: 'Windows denied access.',
  busy: 'it’s open in another app.',
  'name-too-long': 'its name is too long.',
  'invalid-name': 'Windows doesn’t allow its name.',
  'hash-mismatch': 'the copy didn’t match the original, so it was kept.',
  'journal-read-only': 'a newer Taskyard owns the move log.',
  failed: 'it couldn’t be moved.'
}

/** Failure toasts list at most this many files, then "and N more". */
const MAX_LISTED = 5

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`

const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

function listFailures(lines: string[]): string {
  const shown = lines.slice(0, MAX_LISTED)
  if (lines.length > MAX_LISTED) shown.push(`and ${lines.length - MAX_LISTED} more`)
  return shown.join('\n')
}

let nextDrop = 0

interface MovedFile {
  id: string
  token: string
}

/** Undo: the moved files go back (one journaled reverse move each) and leave the layout; files
 * that were already on the desktop go back to where they were placed. */
async function undoDrop(moved: MovedFile[], placedBefore: ItemPlacement[]): Promise<void> {
  const api = getBridge()
  const results = await Promise.all(
    moved.map(async ({ id, token }) => {
      try {
        const result = await api.desktop.undoMove(token)
        return { id, ok: result.ok, code: result.ok ? null : result.code }
      } catch (error) {
        console.error(`dnd: undoing the move of ${id} failed`, error)
        return { id, ok: false, code: 'failed' as const }
      }
    })
  )
  const back = results.filter((result) => result.ok).map((result) => result.id)
  useLayoutStore
    .getState()
    .restorePlacements([...placedBefore, ...back.map((id) => ({ id, displayId: null, at: null }))])
  const failed = results.filter((result) => !result.ok)
  if (failed.length > 0) {
    const byId = useItemsStore.getState().byId
    useUiStore.getState().pushToast({
      tone: 'error',
      message: `${plural(failed.length, 'item')} couldn’t be moved back`,
      description: listFailures(
        failed.map(({ id, code }) => {
          const item = byId[id]
          const name = item ? `${item.name}${item.ext}` : id
          return `${name}: ${MOVE_FAILURES[code ?? 'failed']}`
        })
      )
    })
  }
}

/**
 * Drops Explorer's files at `target`: paths already on a desktop (the items store knows them, by
 * NTFS-style case-insensitive path) are only placed; the rest go through `desktop:moveToDesktop`
 * (main also reports paths it finds on a desktop, with no token). Everything that is on the
 * desktop then is placed in one change, in the dropped order. Failures are listed per file; the
 * Undo toast reverses the moves (`desktop:undoMove`) and the placements.
 */
export async function dropExternalFiles(
  paths: readonly string[],
  target: DropTarget,
  place: DropPlace
): Promise<void> {
  if (paths.length === 0) return
  const ui = useUiStore.getState()
  const byPath = new Map(
    Object.values(useItemsStore.getState().byId).map((item) => [item.path.toUpperCase(), item.id])
  )
  const toMove = paths.filter((path) => !byPath.has(path.toUpperCase()))

  let outcomes: MoveOutcome[] = []
  if (toMove.length > 0) {
    try {
      outcomes = (await getBridge().desktop.moveToDesktop([...toMove])).moves
    } catch (error) {
      console.error('dnd: moveToDesktop failed', error)
      outcomes = toMove.map((from) => ({
        from,
        ok: false,
        code: 'failed',
        message: String(error)
      }))
    }
  }
  const outcomeOf = new Map(outcomes.map((outcome) => [outcome.from.toUpperCase(), outcome]))

  const ids: string[] = []
  const moved: MovedFile[] = []
  const placedOnly: string[] = []
  const failures: string[] = []
  for (const path of paths) {
    const known = byPath.get(path.toUpperCase())
    if (known !== undefined) {
      ids.push(known)
      placedOnly.push(known)
      continue
    }
    const outcome = outcomeOf.get(path.toUpperCase())
    if (!outcome) continue
    if (!outcome.ok) {
      failures.push(`${baseName(path)}: ${MOVE_FAILURES[outcome.code]}`)
      continue
    }
    ids.push(outcome.id)
    if (outcome.token === null) placedOnly.push(outcome.id)
    else moved.push({ id: outcome.id, token: outcome.token })
  }
  const unique = [...new Set(ids)]

  // Where the already-present files were, for Undo; taken before they move.
  const placedBefore = placementsOf(useLayoutStore.getState().layout, [...new Set(placedOnly)])
  if (unique.length > 0) dropItems(place, unique, unique[0], target)

  const drop = ++nextDrop
  if (failures.length > 0) {
    ui.pushToast({
      id: `drop-failed:${drop}`,
      tone: 'error',
      message: `${plural(failures.length, 'item')} couldn’t be moved to the Desktop`,
      description: listFailures(failures)
    })
  }
  if (unique.length > 0) {
    ui.pushToast({
      id: `drop:${drop}`,
      tone: 'success',
      message:
        moved.length > 0
          ? `Moved ${plural(moved.length, 'item')} to the Desktop`
          : `Placed ${plural(unique.length, 'item')}`,
      durationMs: UNDO_DROP_MS,
      action: { label: 'Undo', onAction: () => void undoDrop(moved, placedBefore) }
    })
  }
}
