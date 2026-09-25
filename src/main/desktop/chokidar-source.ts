import { basename } from 'node:path'
import { watch } from 'chokidar'
import { isPartialName } from './classify'
import type { FsEventType } from './watcher'

/**
 * chokidar's `awaitWriteFinish`: an add or change is reported once the size has been stable for
 * this long. Kept well inside the 500 ms rename window, because a renamed file's add is delayed
 * by it too (the unlink is not).
 */
export const WRITE_STABILITY_MS = 200
export const WRITE_POLL_MS = 50

export interface FsWatch {
  close(): Promise<void>
}

export type StartWatching = (
  dirs: readonly string[],
  onEvent: (type: FsEventType, path: string) => void,
  onError: (error: unknown) => void
) => Promise<FsWatch>

const EVENTS: readonly FsEventType[] = ['add', 'addDir', 'change', 'unlink', 'unlinkDir']

/**
 * Watches the desktop folders' direct children (depth 0) with chokidar 4. Resolves once the
 * initial directory read is done, so nothing that happens after `watch` returns is missed.
 */
export const startChokidar: StartWatching = async (dirs, onEvent, onError) => {
  const watcher = watch([...dirs], {
    ignoreInitial: true,
    depth: 0,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: WRITE_STABILITY_MS, pollInterval: WRITE_POLL_MS },
    ignored: (path: string) => isPartialName(basename(path))
  })
  for (const type of EVENTS) watcher.on(type, (path: string) => onEvent(type, path))
  watcher.on('error', onError)
  await new Promise<void>((resolve) => watcher.once('ready', () => resolve()))
  return { close: () => watcher.close() }
}
