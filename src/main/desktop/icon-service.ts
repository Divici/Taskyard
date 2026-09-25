import { createHash } from 'node:crypto'
import type { DesktopChange, DesktopIcon } from '@shared/ipc'
import { splitItemName } from '@shared/item-name'
import type { DesktopItem } from '@shared/schema'
import type { IconBitmap, Win32Api } from '../win32/api'
import {
  DRIVE_REMOTE,
  FILE_ATTRIBUTE_OFFLINE,
  FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
} from '../win32/constants'
import { createIconCache, iconCacheKey, type IconCacheFs } from './icon-cache'
import {
  BASE_ICON_PX,
  iconPx,
  isExtractable,
  planIcon,
  systemFolderIcon,
  type IconPlan
} from './icon-plan'
import { createJobQueue } from './job-queue'

export { iconCacheKey } from './icon-cache'

/** At most this many icons are resolved at once. */
export const ICON_CONCURRENCY = 4

const CLOUD_ONLY = FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_OFFLINE

export interface IconFs extends IconCacheFs {
  stat(path: string): Promise<{ isDirectory(): boolean }>
}

export interface IconLog {
  info(message: string): void
  warn(message: string, ...details: unknown[]): void
  error(message: string, ...details: unknown[]): void
}

export interface IconServiceDeps {
  /** `userData/icons`. */
  cacheDir: string
  fs: IconFs
  win32: Pick<Win32Api, 'extractIcon' | 'getFileAttributes' | 'getDriveType'>
  /** `app.getFileIcon(path, {size: 'normal'})` as PNG bytes (32 px). */
  getFileIcon(path: string): Promise<Buffer>
  /** An extracted bitmap → PNG (`iconBitmapToPng` over Electron's nativeImage). */
  encodePng(icon: IconBitmap): Buffer
  /** Every display's scale factor, now. */
  scaleFactors(): readonly number[]
  emit(event: 'desktop:icon', payload: DesktopIcon): unknown
  log: IconLog
  /** `%SystemRoot%` (the folder icon lives in its System32\imageres.dll). */
  systemRoot: string
  concurrency?: number
  memoryEntries?: number
}

/** Counters since the service started (the boot log line). */
export interface IconStats {
  /** Icons sent from the memory or disk cache. */
  cached: number
  /** Electron 32 px icons fetched. */
  shell: number
  /** Win32 extractions at the display size. */
  extracted: number
  /** Items shown with the built-in icon on purpose (placeholders, network targets). */
  generic: number
  /** Items left with no icon after every step failed. */
  failed: number
}

export interface IconService {
  /** Feeds `desktop:changed`: resolves added and changed items, forgets removed ones. */
  update(change: DesktopChange): void
  /** Feeds `desktop:renamed`: a new extension re-resolves the icon (the cache key is unchanged). */
  renamed(id: string, path: string): void
  /** Displays changed: a larger max scale factor re-extracts at the new size. */
  refreshScale(): void
  /** The best icon sent for every present item (`desktop:icons`, for windows that load late). */
  list(): DesktopIcon[]
  /** Resolves when no icon work is queued or running. */
  idle(): Promise<void>
  /** Deletes cached files of items that are no longer present; returns how many. */
  prune(): Promise<number>
  stats(): IconStats
  /** Stops sending; queued work finishes silently. */
  stop(): void
  /** The size extractions run at: `ceil(64 × max scaleFactor)`, only ever growing. */
  readonly px: number
}

interface Entry {
  item: DesktopItem
  plan: IconPlan
  /** Cache key: sha1(id|mtime|size). */
  key: string
  /** Sent with every icon: the cache key and the plan (a rename or retarget changes it). */
  version: string
  errors: string[]
  sent: boolean
}

type Local = Extract<IconPlan, { kind: 'local' }>

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const fileName = (item: DesktopItem): string => `${item.name}${item.ext}`

/** The icon's version: its cache key plus where it comes from (`planIcon`). */
const iconVersion = (key: string, plan: IconPlan): string =>
  createHash('sha1')
    .update(`${key}|${JSON.stringify(plan)}`)
    .digest('hex')
    .slice(0, 16)

/**
 * Main's icon pipeline. Per item (at most 4 at once):
 * 1. placeholders and network shortcuts stop here: the renderer shows its generic icon by kind,
 *    and nothing is read — not even the cache;
 * 2. the best cached size (`ceil(64 × max scaleFactor)`, else 32) is sent if present;
 * 3. else Electron's 32 px icon is sent, then — after every item's 32 px — the icon resource is
 *    extracted through Win32 at the display size and sent.
 * Every result is cached (memory LRU + `userData/icons`) and streamed as `desktop:icon`.
 */
export function createIconService(deps: IconServiceDeps): IconService {
  const { log } = deps
  const cache = createIconCache({
    dir: deps.cacheDir,
    fs: deps.fs,
    log,
    memoryEntries: deps.memoryEntries
  })
  const queue = createJobQueue(deps.concurrency ?? ICON_CONCURRENCY, (error) =>
    log.error('icons: an icon job failed', error)
  )
  const folderIcon = systemFolderIcon(deps.systemRoot)
  const entries = new Map<string, Entry>()
  /** The icon each item's windows show now (what desktop:icons answers). */
  const latest = new Map<string, DesktopIcon>()
  /** Drive letter → on a mapped network drive; asked once per letter (GetDriveTypeW). */
  const remoteDrives = new Map<string, boolean>()
  const stats: IconStats = { cached: 0, shell: 0, extracted: 0, generic: 0, failed: 0 }
  let px = iconPx(deps.scaleFactors())
  let stopped = false

  const isRemoteDrive = (path: string): boolean => {
    const letter = path.charAt(0).toUpperCase()
    let remote = remoteDrives.get(letter)
    if (remote === undefined) {
      remote = deps.win32.getDriveType(`${letter}:\\`) === DRIVE_REMOTE
      remoteDrives.set(letter, remote)
    }
    return remote
  }

  const live = (entry: Entry): boolean => !stopped && entries.get(entry.item.id) === entry
  const wantedPx = (plan: Local): number =>
    plan.upgrade !== null || plan.folderCheck !== null ? px : BASE_ICON_PX

  const isCloudOnly = (path: string): boolean => {
    const attributes = deps.win32.getFileAttributes(path)
    return attributes !== null && (attributes & CLOUD_ONLY) !== 0
  }

  const send = (entry: Entry, size: number, dataUrl: string): void => {
    if (!live(entry)) return
    const { id } = entry.item
    const current = latest.get(id)
    if (current !== undefined && current.version === entry.version && current.px > size) return
    const icon = { id, px: size, dataUrl, version: entry.version }
    latest.set(id, icon)
    entry.sent = true
    deps.emit('desktop:icon', icon)
  }

  /** The windows drop the item's icon and show the generic one (only if they had one). */
  const clear = (id: string, version: string): void => {
    if (stopped || !latest.delete(id)) return
    deps.emit('desktop:icon', { id, px: 0, dataUrl: null, version })
  }

  const finish = (entry: Entry): void => {
    if (!live(entry) || entry.sent || entry.errors.length === 0) return
    stats.failed++
    // The windows may still show an older version's icon: it no longer applies.
    if (latest.get(entry.item.id)?.version !== entry.version) clear(entry.item.id, entry.version)
    log.warn(
      `icons: ${fileName(entry.item)} has no icon (${entry.errors.join('; ')}), the generic one is shown`
    )
  }

  /** Electron's 32 px icon of `path` (cached). Electron opens .exe/.dll/.ico files only. */
  const baseIcon = async (entry: Entry, path: string): Promise<string | null> => {
    const cached = await cache.get(entry.key, BASE_ICON_PX)
    if (cached !== null) {
      stats.cached++
      return cached
    }
    if (isExtractable(path) && isCloudOnly(path)) {
      entry.errors.push(`${path} is cloud-only`)
      return null
    }
    try {
      const png = await deps.getFileIcon(path)
      stats.shell++
      return await cache.put(entry.key, BASE_ICON_PX, png)
    } catch (error) {
      entry.errors.push(message(error))
      return null
    }
  }

  const upgradeStep = async (entry: Entry, plan: Local): Promise<void> => {
    if (!live(entry) || plan.upgrade === null) return
    const { file, index } = plan.upgrade
    const size = px
    try {
      if (isCloudOnly(file)) {
        entry.errors.push(`${file} is cloud-only`)
        return
      }
      const bitmap = deps.win32.extractIcon(file, index, size)
      if (bitmap === null) {
        entry.errors.push(`no icon ${index} in ${file}`)
        return
      }
      const dataUrl = await cache.put(entry.key, size, deps.encodePng(bitmap))
      stats.extracted++
      send(entry, size, dataUrl)
    } catch (error) {
      entry.errors.push(message(error))
    } finally {
      finish(entry)
    }
  }

  /** A shortcut target without an extension: the folder icon if it is a folder. */
  const settleFolderCheck = async (plan: Local): Promise<Local> => {
    if (plan.folderCheck === null) return plan
    const target = plan.folderCheck
    const isFolder = await deps.fs.stat(target).then(
      (stats) => stats.isDirectory(),
      () => false
    )
    return isFolder
      ? { kind: 'local', base: null, upgrade: folderIcon, folderCheck: null }
      : { kind: 'local', base: target, upgrade: null, folderCheck: null }
  }

  const baseStep = async (entry: Entry, initial: Local): Promise<void> => {
    if (!live(entry)) return
    const best = await cache.get(entry.key, wantedPx(initial))
    if (best !== null) {
      stats.cached++
      send(entry, wantedPx(initial), best)
      return
    }
    const plan = await settleFolderCheck(initial)
    // An earlier pass already sent this version's 32 px (the display size grew since).
    const alreadySent = latest.get(entry.item.id)?.version === entry.version
    if (plan.base !== null && !alreadySent) {
      const dataUrl = await baseIcon(entry, plan.base)
      if (dataUrl !== null) send(entry, BASE_ICON_PX, dataUrl)
    }
    // Queued behind every item's 32 px step, so the whole desktop fills in first.
    if (plan.upgrade !== null) queue.run(() => upgradeStep(entry, plan), 'low')
    else finish(entry)
  }

  const resolve = (item: DesktopItem): void => {
    const plan = planIcon(item, deps.systemRoot, isRemoteDrive)
    const key = iconCacheKey(item)
    const version = iconVersion(key, plan)
    const entry: Entry = { item, plan, key, version, errors: [], sent: false }
    entries.set(item.id, entry)
    if (plan.kind === 'generic') {
      clear(item.id, version)
      stats.generic++
      return
    }
    const current = latest.get(item.id)
    if (current !== undefined && current.version === version && current.px >= wantedPx(plan)) {
      entry.sent = true
      return
    }
    queue.run(() => baseStep(entry, plan))
  }

  return {
    update({ added, removed, changed }) {
      if (stopped) return
      for (const id of removed) {
        entries.delete(id)
        latest.delete(id)
      }
      for (const item of [...added, ...changed]) resolve(item)
    },

    renamed(id, path) {
      const entry = entries.get(id)
      if (stopped || entry === undefined) return
      const item = { ...entry.item, path, ...splitItemName(path, entry.item.kind) }
      if (item.ext.toLowerCase() === entry.item.ext.toLowerCase()) {
        entry.item = item
        return
      }
      // Same id, mtime and size: the cached icons are the old type's. Drop them first. The new
      // plan gives a new version, which replaces the old icon in the windows (or clears it).
      entries.delete(id)
      queue.track(cache.forget(entry.key).then(() => stopped || resolve(item)))
    },

    refreshScale() {
      const next = iconPx(deps.scaleFactors())
      if (stopped || next <= px) return
      log.info(`icons: the largest display scale grew; icons are now ${next} px (were ${px})`)
      px = next
      for (const entry of [...entries.values()]) {
        const { plan } = entry
        if (plan.kind === 'local' && (plan.upgrade !== null || plan.folderCheck !== null)) {
          resolve(entry.item)
        }
      }
    },

    list: () => [...latest.values()].map((icon) => ({ ...icon })),

    idle: () => queue.idle(),

    async prune() {
      const removed = await cache.prune(new Set([...entries.values()].map((entry) => entry.key)))
      if (removed > 0)
        log.info(`icons: removed ${removed} cached icon(s) of changed or deleted items`)
      return removed
    },

    stats: () => ({ ...stats }),

    stop() {
      stopped = true
    },

    get px() {
      return px
    }
  }
}
