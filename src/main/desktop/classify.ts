import type { ItemKind } from '@shared/schema'

/** Programs and installers: shown (and auto-organized, Phase 11) as apps. */
const APP_EXTENSIONS = new Set(['.exe', '.msi', '.bat', '.cmd', '.com', '.appref-ms'])

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/** A desktop entry's kind from its name alone (nothing is opened). */
export function classifyItem(name: string, isDirectory: boolean): ItemKind {
  if (isDirectory) return 'folder'
  const ext = extensionOf(name)
  if (ext === '.lnk') return 'link'
  if (ext === '.url') return 'url'
  if (APP_EXTENSIONS.has(ext)) return 'app'
  return 'file'
}

export function isShortcutKind(kind: ItemKind): kind is 'link' | 'url' {
  return kind === 'link' || kind === 'url'
}

/** `.taskyard-<token>.partial`: a cross-volume move still being copied; never an item. */
const PARTIAL_NAME = /^\.taskyard-[^\\/]+\.partial$/i

export function isPartialName(name: string): boolean {
  return PARTIAL_NAME.test(name)
}
