import type { BigIntStats } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { splitItemName } from '@shared/item-name'
import type { DesktopItem } from '@shared/schema'
import type { Win32Api } from '../win32/api'
import {
  FILE_ATTRIBUTE_HIDDEN,
  FILE_ATTRIBUTE_OFFLINE,
  FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS,
  FILE_ATTRIBUTE_SYSTEM
} from '../win32/constants'
import { classifyItem, isPartialName, isShortcutKind } from './classify'
import type { ShortcutInfo } from './shortcuts'

/** Items read at once: bounded so a huge desktop cannot exhaust file handles. */
export const SCAN_CONCURRENCY = 32

const SKIPPED = FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM
/** OneDrive Files-On-Demand: reading the content would download the file. */
const PLACEHOLDER = FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_OFFLINE

export interface ScanFolder {
  path: string
  /** Windows will not let this user add or delete entries here (Public Desktop). */
  readonly: boolean
}

export interface ScanDeps {
  win32: Pick<Win32Api, 'getFileAttributes' | 'canModifyFolder'>
  /** Shortcut details (shortcuts.ts `readShortcut`); never called for a placeholder. */
  readShortcut: (path: string, kind: 'link' | 'url') => Promise<ShortcutInfo>
  log: { info(message: string): void; warn(message: string, ...details: unknown[]): void }
  concurrency?: number
}

export interface FolderReport extends ScanFolder {
  count: number
  error?: string
}

export interface ScanReport {
  items: DesktopItem[]
  folders: FolderReport[]
  ms: number
  readonlyCount: number
  placeholderCount: number
}

async function statId(path: string): Promise<BigIntStats | null> {
  try {
    return await stat(path, { bigint: true })
  } catch (error) {
    // A broken symlink: its own entry is still a desktop item.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        return await lstat(path, { bigint: true })
      } catch {
        return null
      }
    }
    return null
  }
}

/**
 * One desktop entry as a DesktopItem, or null when it is not shown: gone, hidden or system
 * (desktop.ini), or the temporary copy of an unfinished move. The id is `${dev}:${ino}` of a
 * bigint stat (volume serial + NTFS file index), so it survives renames. A cloud placeholder is
 * flagged and never read (its shortcut details stay unknown until Windows hydrates it).
 */
export async function readDesktopItem(
  path: string,
  folder: ScanFolder,
  deps: Pick<ScanDeps, 'win32' | 'readShortcut'>
): Promise<DesktopItem | null> {
  const fileName = basename(path)
  if (isPartialName(fileName)) return null
  const stats = await statId(path)
  if (stats === null) return null
  const attributes = deps.win32.getFileAttributes(path) ?? 0
  if (attributes & SKIPPED) return null

  const isDirectory = stats.isDirectory()
  const kind = classifyItem(fileName, isDirectory)
  const placeholder = (attributes & PLACEHOLDER) !== 0
  const item: DesktopItem = {
    id: `${stats.dev}:${stats.ino}`,
    path,
    ...splitItemName(path, kind),
    kind,
    mtimeMs: Number(stats.mtimeMs),
    sizeBytes: isDirectory ? 0 : Number(stats.size),
    readonly: folder.readonly,
    placeholder
  }
  if (!placeholder && isShortcutKind(kind)) Object.assign(item, await deps.readShortcut(path, kind))
  return item
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const byName = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/**
 * Lists every desktop folder (user Desktop first, then Public): per folder one
 * `canModifyFolder` check for `readonly`, per entry `readDesktopItem`. A folder that cannot be
 * read is reported and skipped. One item per file id (a hard link seen twice is shown once).
 */
export async function scanDesktop(dirs: readonly string[], deps: ScanDeps): Promise<ScanReport> {
  const started = performance.now()
  const folders: FolderReport[] = []
  const items: DesktopItem[] = []
  const seen = new Set<string>()

  for (const dir of dirs) {
    const folder: ScanFolder = { path: dir, readonly: !deps.win32.canModifyFolder(dir) }
    let names: string[]
    try {
      names = (await readdir(dir)).sort((a, b) => byName.compare(a, b))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.log.warn(`scan: cannot read ${dir} (${message})`)
      folders.push({ ...folder, count: 0, error: message })
      continue
    }
    const read = await mapLimit(names, deps.concurrency ?? SCAN_CONCURRENCY, (name) =>
      readDesktopItem(join(dir, name), folder, deps)
    )
    let count = 0
    for (const item of read) {
      if (item === null) continue
      if (seen.has(item.id)) {
        deps.log.warn(`scan: ${item.path} has the same file id as an item already listed; skipped`)
        continue
      }
      seen.add(item.id)
      items.push(item)
      count += 1
    }
    folders.push({ ...folder, count })
  }

  return {
    items,
    folders,
    ms: performance.now() - started,
    readonlyCount: items.filter((item) => item.readonly).length,
    placeholderCount: items.filter((item) => item.placeholder).length
  }
}

/** The boot log line: `scan: N items in <ms> ms (R readonly, P placeholders)`. */
export function describeScan(
  report: Pick<ScanReport, 'items' | 'ms' | 'readonlyCount' | 'placeholderCount'>
): string {
  return (
    `scan: ${report.items.length} items in ${Math.round(report.ms)} ms ` +
    `(${report.readonlyCount} readonly, ${report.placeholderCount} placeholders)`
  )
}
