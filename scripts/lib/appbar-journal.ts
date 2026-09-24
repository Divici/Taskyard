import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Where `verify:zorder` records the taskbar's original appbar state before switching auto-hide
 * on. If the run is killed before its `finally`, the next run restores from this file.
 */
export const APPBAR_JOURNAL_FILE = join(tmpdir(), 'taskyard-verify-zorder-appbar.json')

export interface AppbarJournal {
  /** Records `state` as the original, unless an original is already recorded. */
  save(state: number): void
  /** The recorded original state, or null. */
  pending(): number | null
  clear(): void
}

interface JournalFile {
  originalAppbarState: number
  savedAt: string
  pid: number
}

export function appbarJournal(file: string = APPBAR_JOURNAL_FILE): AppbarJournal {
  const pending = (): number | null => {
    if (!existsSync(file)) return null
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<JournalFile>
      if (typeof data.originalAppbarState === 'number') return data.originalAppbarState
    } catch {
      // Unreadable: fall through and drop it.
    }
    rmSync(file, { force: true })
    return null
  }

  return {
    save(state) {
      if (pending() !== null) return
      const data: JournalFile = {
        originalAppbarState: state,
        savedAt: new Date().toISOString(),
        pid: process.pid
      }
      writeFileSync(file, JSON.stringify(data))
    },
    pending,
    clear() {
      rmSync(file, { force: true })
    }
  }
}

/**
 * Restores the taskbar state an interrupted run left behind. Returns the restored state, or
 * null when the last run finished cleanly. The journal is cleared only after a successful set.
 */
export function healInterruptedRun(
  journal: AppbarJournal,
  setState: (state: number) => void
): number | null {
  const original = journal.pending()
  if (original === null) return null
  setState(original)
  journal.clear()
  return original
}
