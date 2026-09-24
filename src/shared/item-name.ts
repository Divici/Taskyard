import type { ItemKind } from './schema'

/** Last segment of a Windows or POSIX path; a trailing separator is ignored. */
export function baseName(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean)
  return segments.at(-1) ?? path
}

/**
 * Splits a desktop item's file name into the display name and the extension (with its dot, case
 * as on disk). Folders are never split, and a leading dot (`.gitignore`) belongs to the name.
 * The scanner (Phase 4) and the renderer's rename handling share this rule.
 */
export function splitItemName(path: string, kind: ItemKind): { name: string; ext: string } {
  const fileName = baseName(path)
  if (kind === 'folder') return { name: fileName, ext: '' }

  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return { name: fileName, ext: '' }
  return { name: fileName.slice(0, dot), ext: fileName.slice(dot) }
}
