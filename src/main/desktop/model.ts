import type { DesktopItem } from '@shared/schema'

/** Paths compare the NTFS way (Decision 7: `toUpperCase`). */
export const pathKey = (path: string): string => path.toUpperCase()

/**
 * Main's picture of the desktop: items by file id, plus the path → id map the watcher needs
 * (an unlinked path can no longer be stat'ed, so its id must be remembered). Only the tracker
 * (watcher.ts) changes it after the boot scan.
 */
export class DesktopModel {
  private readonly byId = new Map<string, DesktopItem>()
  private readonly idByPath = new Map<string, string>()

  constructor(items: readonly DesktopItem[] = []) {
    this.replaceAll(items)
  }

  get size(): number {
    return this.byId.size
  }

  list(): DesktopItem[] {
    return [...this.byId.values()]
  }

  get(id: string): DesktopItem | undefined {
    return this.byId.get(id)
  }

  idAt(path: string): string | undefined {
    return this.idByPath.get(pathKey(path))
  }

  /** Adds or replaces the item (its old path, if it moved, is forgotten). */
  put(item: DesktopItem): void {
    const previous = this.byId.get(item.id)
    if (previous && this.idByPath.get(pathKey(previous.path)) === item.id) {
      this.idByPath.delete(pathKey(previous.path))
    }
    const occupant = this.idByPath.get(pathKey(item.path))
    if (occupant !== undefined && occupant !== item.id) this.byId.delete(occupant)
    this.byId.set(item.id, item)
    this.idByPath.set(pathKey(item.path), item.id)
  }

  remove(id: string): DesktopItem | undefined {
    const item = this.byId.get(id)
    if (!item) return undefined
    this.byId.delete(id)
    if (this.idByPath.get(pathKey(item.path)) === id) this.idByPath.delete(pathKey(item.path))
    return item
  }

  replaceAll(items: readonly DesktopItem[]): void {
    this.byId.clear()
    this.idByPath.clear()
    for (const item of items) this.put(item)
  }
}

/** Every field equal (items are flat except optional strings/numbers). */
export function sameItem(a: DesktopItem, b: DesktopItem): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof DesktopItem>
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}
