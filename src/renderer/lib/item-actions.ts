import type { DesktopErrorCode, DesktopFailure } from '@shared/ipc'
import type { DesktopItem } from '@shared/schema'
import { useUiStore } from '../stores/ui'
import { getBridge } from './bridge'

// What the user can do to desktop items from the keyboard, the canvas and the icon menu (Phase 9):
// open, open file location, rename, copy path, move to the Recycle Bin. Main does the work
// (Phase 4's typed results); this words the outcome.

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

/** What an unexplained failure (`failed`) says, by action. */
type Action = 'change' | 'open' | 'show'

const FAILED_MESSAGES: Readonly<Record<Action, string>> = {
  change: FAILURE_MESSAGES.failed,
  open: 'couldn’t be opened.',
  show: 'couldn’t be shown in File Explorer.'
}

function reportFailure(
  item: DesktopItem,
  failure: DesktopFailure,
  action: Action = 'change'
): void {
  useUiStore.getState().pushToast({
    id: `item-failed:${item.id}`,
    tone: 'error',
    message: `“${fileName(item)}” ${failure.code === 'failed' ? FAILED_MESSAGES[action] : FAILURE_MESSAGES[failure.code]}`,
    // Windows' own words (e.g. openPath's "No application is associated…").
    description: failure.code === 'failed' ? failure.message : undefined
  })
}

function reportRejection(item: DesktopItem, error: unknown, action: Action = 'change'): void {
  console.error(`desktop: an action on ${item.id} failed`, error)
  reportFailure(item, { ok: false, code: 'failed', message: String(error) }, action)
}

/**
 * Opens each item with its default app, as a double-click on the Windows desktop does: a `.lnk`
 * opens its target, a `.url` the browser, a folder File Explorer. Failures become toasts.
 */
export async function openItems(items: readonly DesktopItem[]): Promise<void> {
  const api = getBridge()
  await Promise.all(
    items.map(async (item) => {
      try {
        const result = await api.desktop.open(item.id)
        if (!result.ok) reportFailure(item, result, 'open')
      } catch (error) {
        reportRejection(item, error, 'open')
      }
    })
  )
}

/** "Open file location": File Explorer with the item selected. */
export async function showItemInFolder(item: DesktopItem): Promise<void> {
  try {
    const result = await getBridge().desktop.showInFolder(item.id)
    if (!result.ok) reportFailure(item, result, 'show')
  } catch (error) {
    reportRejection(item, error, 'show')
  }
}

/** Puts the items' full paths on the clipboard, one per line (Explorer's "Copy as path"). */
export async function copyPaths(items: readonly DesktopItem[]): Promise<void> {
  if (items.length === 0) return
  const ui = useUiStore.getState()
  try {
    await navigator.clipboard.writeText(items.map((item) => item.path).join('\r\n'))
    ui.pushToast({
      id: 'copy-path',
      tone: 'success',
      message: items.length === 1 ? 'Path copied' : `${items.length} paths copied`,
      durationMs: 2_000
    })
  } catch (error) {
    console.error('desktop: copying the paths failed', error)
    ui.pushToast({ id: 'copy-path', tone: 'error', message: 'Taskyard couldn’t copy the path.' })
  }
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

/**
 * How a rename ended. `retry`: the name itself is the problem (it exists, or Windows does not
 * allow it) — the field reopens on it with `error` (Phase 9). Any other failure was a toast.
 */
export type RenameOutcome =
  { status: 'renamed' | 'unchanged' | 'failed' } | { status: 'retry'; error: string }

/** Failures about the name the user typed: shown in the rename field, not as a toast. */
function inlineRenameError(code: DesktopErrorCode, next: string): string | null {
  switch (code) {
    case 'exists':
      return `An item named “${next}” already exists. Choose another name.`
    case 'invalid-name':
      return `Windows doesn’t allow the name “${next}”.`
    case 'name-too-long':
      return 'That name is longer than 255 characters.'
    default:
      return null
  }
}

/** Renames the file on disk through main (the id, and so the placement, stays). */
export async function renameItem(
  item: DesktopItem,
  typed: string,
  showExtension: boolean
): Promise<RenameOutcome> {
  const next = renamedFileName(item, typed, showExtension)
  if (next === fileName(item)) return { status: 'unchanged' }
  try {
    const result = await getBridge().desktop.rename(item.id, next)
    if (result.ok) return { status: 'renamed' }
    const inline = inlineRenameError(result.code, next)
    if (inline !== null) return { status: 'retry', error: inline }
    reportFailure(item, result)
    return { status: 'failed' }
  } catch (error) {
    reportRejection(item, error)
    return { status: 'failed' }
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
