import { win32 } from 'node:path'
import type { DesktopItem } from '@shared/schema'

/** Electron's `app.getFileIcon(path, {size: 'normal'})` is 32×32 on Windows. */
export const BASE_ICON_PX = 32
/** The CSS size Taskyard designs icons for; `iconPx` scales it to physical pixels. */
export const ICON_CSS_PX = 64

/** Files `PrivateExtractIconsW` reads icon resources from (Assumption 15). */
const EXTRACTABLE = new Set(['.exe', '.dll', '.ico'])

/** An icon resource: `index` ≥ 0 is the n-th icon, < 0 the resource id `-index`. */
export interface IconSource {
  file: string
  index: number
}

export type GenericReason =
  /** A cloud-only file: reading it (or its icon) would download it. */
  | 'placeholder'
  /** A shortcut to the network: a dead share can block for seconds. */
  | 'remote'
  /** A shortcut with no target path and no icon location. */
  | 'no-source'

/**
 * Where an item's icon comes from. `generic`: the renderer's built-in icon for the item's kind;
 * nothing is read. `local`: Electron's 32 px icon of `base`, then `upgrade` extracted at the
 * display size; `folderCheck` is a shortcut target without an extension, which a stat decides
 * (a folder gets the folder icon, anything else its 32 px icon).
 */
export type IconPlan =
  | { kind: 'generic'; reason: GenericReason }
  | {
      kind: 'local'
      base: string | null
      upgrade: IconSource | null
      folderCheck: string | null
    }

/** `ceil(64 × max scaleFactor over all displays)`, never below 64. */
export function iconPx(scaleFactors: readonly number[]): number {
  return Math.ceil(ICON_CSS_PX * Math.max(1, ...scaleFactors))
}

/** The Windows folder icon: `imageres.dll`, resource 3 (what Explorer shows for a folder). */
export function systemFolderIcon(systemRoot: string): IconSource {
  return { file: win32.join(systemRoot, 'System32', 'imageres.dll'), index: -3 }
}

/** A drive-letter path. UNC paths (`\\server\share`, `\\?\UNC\…`) never count as local. */
function isLocalPath(path: string | undefined): path is string {
  return path !== undefined && /^[a-z]:\\/i.test(path)
}

const extension = (path: string): string => win32.extname(path).toLowerCase()
/** `.exe`, `.dll` or `.ico`: a file with icon resources (Electron opens these to draw them). */
export const isExtractable = (path: string): boolean => EXTRACTABLE.has(extension(path))

/** True for a path on a mapped network drive (`GetDriveTypeW` = DRIVE_REMOTE); never read. */
export type IsRemoteDrive = (path: string) => boolean

/** `iconPath` when it is a local icon resource (not UNC, not on a mapped network drive). */
function iconLocation(item: DesktopItem, isRemoteDrive: IsRemoteDrive): IconSource | null {
  if (!isLocalPath(item.iconPath) || isRemoteDrive(item.iconPath)) return null
  if (!isExtractable(item.iconPath)) return null
  return { file: item.iconPath, index: item.iconIndex ?? 0 }
}

/** Electron can only draw icon 0 of a resource file; another index needs extraction. */
const baseOf = (upgrade: IconSource | null): string | null =>
  upgrade !== null && upgrade.index === 0 ? upgrade.file : null

const local = (
  base: string | null,
  upgrade: IconSource | null,
  folderCheck: string | null = null
): IconPlan => ({ kind: 'local', base, upgrade, folderCheck })

function planLink(item: DesktopItem, isRemoteDrive: IsRemoteDrive): IconPlan {
  // A target on a mapped network drive is remote even when the .lnk did not say so.
  if (isLocalPath(item.targetPath) && isRemoteDrive(item.targetPath)) {
    return { kind: 'generic', reason: 'remote' }
  }
  const target = isLocalPath(item.targetPath) ? item.targetPath : undefined
  const targetIcon =
    target !== undefined && isExtractable(target)
      ? { file: target, index: item.iconIndex ?? 0 }
      : null
  const upgrade = iconLocation(item, isRemoteDrive) ?? targetIcon
  if (target === undefined) {
    return upgrade === null
      ? { kind: 'generic', reason: 'no-source' }
      : local(baseOf(upgrade), upgrade)
  }
  if (extension(target) === '') return local(baseOf(upgrade), upgrade, upgrade ? null : target)
  return local(baseOf(upgrade) ?? target, upgrade)
}

/**
 * Decides, without touching the disk, where `item`'s icon comes from. Electron's own icon is
 * grouped by extension on Windows (every `.lnk` gets the same blank page, every folder a drive),
 * so shortcuts use their target and folders the system folder icon. Shortcut targets and icon
 * locations on a mapped network drive (`isRemoteDrive`) are never used: a disconnected share
 * would block the main thread.
 */
export function planIcon(
  item: DesktopItem,
  systemRoot: string,
  isRemoteDrive: IsRemoteDrive = () => false
): IconPlan {
  if (item.placeholder) return { kind: 'generic', reason: 'placeholder' }
  switch (item.kind) {
    case 'folder':
      return local(null, systemFolderIcon(systemRoot))
    case 'app':
      return local(item.path, isExtractable(item.path) ? { file: item.path, index: 0 } : null)
    case 'link':
      return item.targetRemote === true
        ? { kind: 'generic', reason: 'remote' }
        : planLink(item, isRemoteDrive)
    case 'url': {
      const upgrade = iconLocation(item, isRemoteDrive)
      return local(baseOf(upgrade) ?? item.path, upgrade)
    }
    case 'file':
      return local(item.path, null)
  }
}
