import type { DataFileName, ReadOnlyInfo, StorageRecovered, StoreName } from '@shared/ipc'
import { baseName } from '@shared/item-name'
import type { ToastInput } from '../stores/ui'

const FILES: Record<DataFileName, { phrase: string; plural: boolean }> = {
  settings: { phrase: 'your settings', plural: true },
  layout: { phrase: 'your desktop layout', plural: false },
  tasks: { phrase: 'your tasks and timer', plural: true },
  ops: { phrase: 'the record of recent file moves', plural: false }
}

/** How long a "restored from backup" notice stays; a reset to defaults stays until dismissed. */
export const RECOVERED_TOAST_MS = 10_000

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function recoveryToast(info: StorageRecovered): ToastInput {
  const { phrase } = FILES[info.store]
  const description = `The unreadable file was kept as ${baseName(info.corruptPath)}.`
  return info.restoredFrom === 'backup'
    ? {
        id: `storage-recovered:${info.store}`,
        tone: 'warning',
        message: `Taskyard couldn’t read ${phrase}, so it restored the last backup.`,
        description,
        durationMs: RECOVERED_TOAST_MS
      }
    : {
        id: `storage-recovered:${info.store}`,
        tone: 'error',
        message: `Taskyard couldn’t read ${phrase} and started fresh.`,
        description,
        durationMs: null
      }
}

export function saveFailedToast(store: StoreName): ToastInput {
  return {
    id: `save-failed:${store}`,
    tone: 'error',
    message: `Couldn’t save ${FILES[store].phrase}.`,
    description: 'The change was undone, so what you see matches what is saved.'
  }
}

export const LOAD_FAILED_TOAST: ToastInput = {
  id: 'storage-load-failed',
  tone: 'error',
  message: 'Taskyard couldn’t load your saved data. Changes won’t be saved this session.',
  durationMs: null
}

/** One sentence per read-only file, then what it means for the user. */
export function readOnlySentences(readOnly: readonly ReadOnlyInfo[]): string[] {
  const sentences = readOnly.map(({ store, reason, version }) => {
    const { phrase, plural } = FILES[store]
    if (reason === 'future-version') {
      const format = version === undefined ? '' : ` (format v${version})`
      return `${capitalize(phrase)} ${plural ? 'were' : 'was'} saved by a newer version of Taskyard${format}.`
    }
    return `Taskyard couldn’t open ${phrase}, so it won’t overwrite ${plural ? 'them' : 'it'}.`
  })
  sentences.push('Changes you make now won’t be saved.')
  if (readOnly.some(({ reason }) => reason === 'future-version')) {
    sentences.push('Update Taskyard to keep editing.')
  }
  return sentences
}
