import type { DesktopChange } from '@shared/ipc'
import { forgetItemIds } from '@shared/layout-ids'
import type { LayoutFile } from '@shared/schema'
import type { JsonStore } from './json-store'
import type { OpsJournal, ReplayReport } from './ops-journal'
import type { StorageLog } from './versioned-file'

export interface ReplayJournalDeps {
  journal: Pick<OpsJournal, 'replay' | 'prune'>
  layout: Pick<JsonStore<LayoutFile>, 'get' | 'save' | 'flush'>
  emit: (event: 'desktop:changed', payload: DesktopChange) => unknown
  log: Pick<StorageLog, 'info' | 'warn'>
}

/**
 * Boot step "opsJournal.replay()": resolves interrupted moves, then makes sure no placement
 * survives for a destination a rollback deleted — scrubbed from the layout (and flushed) before
 * any window hydrates it, and announced as `desktop:changed {removed}` for renderers already
 * listening. Closed ops leave the journal only after that, so a crash in between just repeats
 * the scrub next boot.
 */
export async function replayJournal(deps: ReplayJournalDeps): Promise<ReplayReport> {
  const report = await deps.journal.replay()
  if (report.finished.length > 0 || report.rolledBack.length > 0) {
    deps.log.info(
      `ops: replay finished ${report.finished.length}, rolled back ${report.rolledBack.length}`
    )
  }

  let scrubbed = true
  if (report.removedIds.length > 0) {
    const layout = deps.layout.get()
    const next = forgetItemIds(layout, report.removedIds)
    if (next !== layout) {
      const result = deps.layout.save(next)
      if (result.ok) {
        await deps.layout.flush()
      } else {
        scrubbed = false
        deps.log.warn(
          `ops: layout is ${result.reason}; could not forget ${report.removedIds.length} removed id(s)` +
            ' — the ops stay journaled and are retried next boot'
        )
      }
    }
    deps.emit('desktop:changed', { added: [], removed: [...report.removedIds], changed: [] })
  }

  if (scrubbed) deps.journal.prune()
  return report
}
