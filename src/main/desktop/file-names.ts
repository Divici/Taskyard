import { lstat } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { splitItemName } from '@shared/item-name'

/** NTFS's limit for one path component. */
export const MAX_NAME_LENGTH = 255

// Control characters and <>:"/\|?* (https://learn.microsoft.com/windows/win32/fileio/naming-a-file).
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/
/** Device names Windows reserves, with or without an extension (COM¹-³ and LPT¹-³ included). */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/** Why `name` cannot be a file name on the desktop, or null when it can. */
export function validateFileName(name: string): 'invalid-name' | 'name-too-long' | null {
  if (name.length > MAX_NAME_LENGTH) return 'name-too-long'
  if (name.trim() === '' || name === '.' || name === '..') return 'invalid-name'
  if (FORBIDDEN.test(name) || RESERVED.test(name)) return 'invalid-name'
  // Win32 strips a trailing dot or space; through \\?\ paths the file would keep it and Explorer
  // could not open it.
  if (/[. ]$/.test(name)) return 'invalid-name'
  return null
}

/**
 * A drive root (`D:\`), a UNC share root (`\\server\share`) or their `\\?\` forms: never a
 * movable item. Moving one would copy a whole drive and then delete it.
 */
export function isVolumeOrShareRoot(path: string): boolean {
  if (/^[a-z]:\\*$/i.test(path)) return true
  if (/^\\\\[?.]\\[a-z]:\\?$/i.test(path)) return true
  if (/^\\\\\?\\UNC\\[^\\]+\\[^\\]+\\?$/i.test(path)) return true
  if (/^\\\\[^\\?.][^\\]*\\[^\\]+\\?$/.test(path)) return true
  const resolved = win32.resolve(path)
  return win32.dirname(resolved) === resolved || win32.basename(resolved) === ''
}

/** `report.pdf` → `report (2).pdf`; folders are never split (`Stuff.2024 (2)`). */
export function suffixedName(name: string, n: number, isDirectory: boolean): string {
  const { name: base, ext } = splitItemName(name, isDirectory ? 'folder' : 'file')
  return `${base} (${n})${ext}`
}

async function taken(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * The first free name for `name` in `dir`, Windows style: `name`, then `name (2)`, `name (3)`…
 * The file system answers "taken", so the comparison is NTFS's own (case-insensitive).
 */
export async function freeName(dir: string, name: string, isDirectory: boolean): Promise<string> {
  let candidate = join(dir, name)
  for (let n = 2; await taken(candidate); n++) {
    candidate = join(dir, suffixedName(name, n, isDirectory))
  }
  return candidate
}
