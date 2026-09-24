import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** Files hashed at once inside a folder tree; bounded so a huge folder cannot hit EMFILE. */
export const HASH_CONCURRENCY = 8

export interface HashOptions {
  /** Hashes one file (injectable for tests). */
  hashFile?: (path: string) => Promise<string>
  concurrency?: number
}

/**
 * A desktop item's stable id: `${dev}:${ino}` from a bigint stat — the volume serial number plus
 * the NTFS file index. It survives renames on the same volume (Explorer's or ours).
 */
export async function fileIdOf(path: string): Promise<string> {
  const stats = await stat(path, { bigint: true })
  return `${stats.dev}:${stats.ino}`
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Like `Promise.all(items.map(fn))`, but with at most `limit` calls running at once. */
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

/** Hash of a folder tree: every entry's relative path, type and content, in a stable order. */
async function hashTree(
  root: string,
  hashFile: (path: string) => Promise<string>,
  concurrency: number
): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const lines = await mapLimit(entries, concurrency, async (entry) => {
    const full = join(entry.parentPath, entry.name)
    const rel = relative(root, full).replaceAll('\\', '/')
    if (entry.isDirectory()) return `d ${rel}`
    if (entry.isSymbolicLink()) return `l ${rel} ${await readlink(full)}`
    return `f ${rel} ${await hashFile(full)}`
  })
  const hash = createHash('sha256')
  for (const line of lines.sort()) hash.update(`${line}\n`)
  return hash.digest('hex')
}

/** SHA-256 of a file, or of a whole folder tree; used to verify a cross-volume copy. */
export async function hashPath(path: string, options: HashOptions = {}): Promise<string> {
  const hashFile = options.hashFile ?? sha256OfFile
  const stats = await lstat(path)
  return stats.isDirectory()
    ? hashTree(path, hashFile, options.concurrency ?? HASH_CONCURRENCY)
    : hashFile(path)
}
