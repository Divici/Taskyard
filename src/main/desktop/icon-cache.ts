import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { DesktopItem } from '@shared/schema'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** `<sha1>@<px>.png` — anything else in the folder is left alone. */
const CACHE_FILE = /^([0-9a-f]{40})@(\d+)\.png$/

/** In-memory entries (data URLs of ~2–20 KB): far above any real desktop's item count × 2. */
export const DEFAULT_MEMORY_ENTRIES = 1024

/** The file system calls the cache makes (node:fs/promises in the app, spied on in tests). */
export interface IconCacheFs {
  readFile(path: string): Promise<Buffer>
  writeFile(path: string, data: Buffer): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  readdir(path: string): Promise<string[]>
  unlink(path: string): Promise<void>
}

export interface IconCacheLog {
  info(message: string): void
  warn(message: string, ...details: unknown[]): void
}

/**
 * `sha1(id|mtime|size)`: a file changed on disk gets a new key, so its cached icons are simply
 * never looked up again (and pruned at the next boot).
 */
export function iconCacheKey(item: Pick<DesktopItem, 'id' | 'mtimeMs' | 'sizeBytes'>): string {
  return createHash('sha1').update(`${item.id}|${item.mtimeMs}|${item.sizeBytes}`).digest('hex')
}

export const cacheFileName = (key: string, px: number): string => `${key}@${px}.png`

export const toDataUrl = (png: Buffer): string => `data:image/png;base64,${png.toString('base64')}`

const isPng = (bytes: Buffer): boolean =>
  bytes.length > PNG_SIGNATURE.length &&
  bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | null)?.code

/** A Map in least-recently-used order: reads move an entry to the end, inserts evict the head. */
class Lru<V> {
  private readonly map = new Map<string, V>()
  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as string)
  }

  deleteWhere(match: (key: string) => boolean): void {
    for (const key of [...this.map.keys()]) if (match(key)) this.map.delete(key)
  }
}

export interface IconCache {
  /** The cached icon as a data URL: memory first, then `<dir>/<key>@<px>.png`; null on a miss. */
  get(key: string, px: number): Promise<string | null>
  /** Remembers the PNG and writes it to disk (temp file + rename). A failed write is only logged. */
  put(key: string, px: number, png: Buffer): Promise<string>
  /** Drops every size of `key`, in memory and on disk. */
  forget(key: string): Promise<void>
  /** Deletes the cache files whose key is not in `keep`; returns how many. */
  prune(keep: ReadonlySet<string>): Promise<number>
}

export interface IconCacheOptions {
  dir: string
  fs: IconCacheFs
  log: IconCacheLog
  memoryEntries?: number
}

/** The icon cache: an LRU of data URLs over `userData/icons/<sha1(id|mtime|size)>@<px>.png`. */
export function createIconCache({
  dir,
  fs,
  log,
  memoryEntries = DEFAULT_MEMORY_ENTRIES
}: IconCacheOptions): IconCache {
  const memory = new Lru<string>(memoryEntries)
  let madeDir: Promise<unknown> | null = null
  let tempCounter = 0

  const listFiles = async (): Promise<string[]> => {
    try {
      return await fs.readdir(dir)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') log.warn('icons: listing the icon cache failed', error)
      return []
    }
  }

  return {
    async get(key, px) {
      const name = cacheFileName(key, px)
      const remembered = memory.get(name)
      if (remembered !== undefined) return remembered
      let bytes: Buffer
      try {
        bytes = await fs.readFile(join(dir, name))
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') log.warn(`icons: reading ${name} failed`, error)
        return null
      }
      if (!isPng(bytes)) {
        log.info(`icons: ${name} is not a PNG; extracting the icon again`)
        return null
      }
      const dataUrl = toDataUrl(bytes)
      memory.set(name, dataUrl)
      return dataUrl
    },

    async put(key, px, png) {
      const name = cacheFileName(key, px)
      const dataUrl = toDataUrl(png)
      memory.set(name, dataUrl)
      const temp = join(dir, `${name}.${process.pid}-${++tempCounter}.tmp`)
      try {
        madeDir ??= fs.mkdir(dir, { recursive: true })
        await madeDir
        await fs.writeFile(temp, png)
        await fs.rename(temp, join(dir, name))
      } catch (error) {
        madeDir = null
        log.warn(`icons: caching ${name} failed`, error)
        await fs.unlink(temp).catch(() => {})
      }
      return dataUrl
    },

    async forget(key) {
      memory.deleteWhere((name) => name.startsWith(`${key}@`))
      for (const name of await listFiles()) {
        if (CACHE_FILE.exec(name)?.[1] === key) await fs.unlink(join(dir, name)).catch(() => {})
      }
    },

    async prune(keep) {
      let removed = 0
      for (const name of await listFiles()) {
        const key = CACHE_FILE.exec(name)?.[1]
        if (key === undefined || keep.has(key)) continue
        try {
          await fs.unlink(join(dir, name))
          removed++
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') log.warn(`icons: removing ${name} failed`, error)
        }
      }
      memory.deleteWhere((name) => !keep.has(name.slice(0, name.indexOf('@'))))
      return removed
    }
  }
}
