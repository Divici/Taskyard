import type { DesktopErrorCode, DesktopFailure } from '@shared/ipc'
import type { DesktopItem } from '@shared/schema'
import { useUiStore } from '../stores/ui'
import { getBridge } from './bridge'

// What the user can do to desktop items from the keyboard and the canvas: open, rename, move to
// the Recycle Bin. Main does the work (Phase 4's typed results); this words the outcome.
// Phase 9 adds the icon context menu on top of the same functions.

const FAILURE_MESSAGES: Readonly<Record<DesktopErrorCode, string>> = {
  'not-found': 'isn’t on the desktop any more.',
  readonly: 'is in a folder Windows won’t let you change.',
  exists: 'can’t be renamed: an item with that name already exists.',
  permission: 'can’t be changed: Windows denied access.',
  busy: 'is open in another app. Close it and try again.',
  'name-too-long': 'can’t be renamed: the name is longer than 255 characters.',
  'invalid-name': 'can’t be renamed: Windows doesn’t allow that name.',
  'hash-mismatch': 'wasn’t moved: the copy didn’t match the original, so it was kept.',
  'journal-read-only': 'wasn’t moved: a newer Taskyard owns the move log.',
  failed: 'couldn’t be changed.'
}

function fileName(item: Pick<DesktopItem, 'name' | 'ext'>): string {
  return `${item.name}${item.ext}`
}

function reportFailure(item: DesktopItem, failure: DesktopFailure): void {
  useUiStore.getState().pushToast({
    id: `item-failed:${item.id}`,
    tone: 'error',
    message: `“${fileName(item)}” ${FAILURE_MESSAGES[failure.code]}`,
    description: failure.code === 'failed' ? failure.message : undefined
  })
}

function reportRejection(item: DesktopItem, error: unknown): void {
  console.error(`desktop: an action on ${item.id} failed`, error)
  reportFailure(item, { ok: false, code: 'failed', message: String(error) })
}

/** Opens each item with its default app (`.url` in the browser); failures become toasts. */
export async function openItems(items: readonly DesktopItem[]): Promise<void> {
  const api = getBridge()
  await Promise.all(
    items.map(async (item) => {
      try {
        const result = await api.desktop.open(item.id)
        if (!result.ok) reportFailure(item, result)
      } catch (error) {
        reportRejection(item, error)
      }
    })
  )
}

/**
 * The file name a rename produces from what the user typed: when the label hides the extension
 * (shortcuts always, other files unless "show extensions" is on), the extension is kept.
 */
export function renamedFileName(
  item: Pick<DesktopItem, 'kind' | 'ext'>,
  typed: string,
  showExtension: boolean
): string {
  // Folders have no extension (`ext` is ''), so they always take the typed name.
  const labelHidesExtension = item.kind === 'link' || item.kind === 'url' || !showExtension
  return labelHidesExtension ? `${typed}${item.ext}` : typed
}

/** Renames the file on disk through main (the id, and so the placement, stays). */
export async function renameItem(
  item: DesktopItem,
  typed: string,
  showExtension: boolean
): Promise<boolean> {
  const next = renamedFileName(item, typed, showExtension)
  if (next === fileName(item)) return false
  try {
    const result = await getBridge().desktop.rename(item.id, next)
    if (!result.ok) {
      reportFailure(item, result)
      return false
    }
    return true
  } catch (error) {
    reportRejection(item, error)
    return false
  }
}

/** Names listed in a confirm: at most 5, then "and N more". */
export function listNames(items: readonly Pick<DesktopItem, 'name' | 'ext'>[]): string {
  const names = items.slice(0, 5).map(fileName)
  const more = items.length - names.length
  return more > 0 ? `${names.join('\n')}\nand ${more} more` : names.join('\n')
}

/**
 * Asks, then moves the items to the Recycle Bin. Read-only items are left out (and said so);
 * nothing happens when none are left or the user cancels.
 */
export async function trashItems(items: readonly DesktopItem[]): Promise<void> {
  const ui = useUiStore.getState()
  const allowed = items.filter((item) => !item.readonly)
  const skipped = items.length - allowed.length
  if (allowed.length === 0) {
    if (skipped > 0) {
      ui.pushToast({
        id: 'trash-readonly',
        tone: 'warning',
        message:
          skipped === 1
            ? `“${fileName(items[0])}” is in a folder Windows won’t let you change.`
            : 'These items are in a folder Windows won’t let you change.'
      })
    }
    return
  }
  const title =
    allowed.length === 1
      ? `Move “${fileName(allowed[0])}” to the Recycle Bin?`
      : `Move ${allowed.length} items to the Recycle Bin?`
  const note =
    skipped > 0 ? `\n\n${skipped} read-only item${skipped === 1 ? '' : 's'} will be kept.` : ''
  const ok = await ui.confirm({
    title,
    description: `${listNames(allowed)}${note}`,
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  const api = getBridge()
  for (const item of allowed) {
    try {
      const result = await api.desktop.trash(item.id)
      if (!result.ok) reportFailure(item, result)
    } catch (error) {
      reportRejection(item, error)
    }
  }
}
