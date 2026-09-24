import { win32 } from 'node:path'

const EXTENDED_PREFIX = '\\\\?\\'
const DEVICE_PREFIX = '\\\\.\\'
const UNC_PREFIX = '\\\\'

/**
 * The `\\?\` (extended-length) form of a Windows path, so Win32 calls accept paths past
 * MAX_PATH (260). Windows does not normalize `\\?\` paths, so the path is resolved first
 * (separators, `.`/`..`, trailing slashes). UNC paths become `\\?\UNC\server\share\…`.
 */
export function toExtendedLengthPath(path: string): string {
  if (path.startsWith(EXTENDED_PREFIX) || path.startsWith(DEVICE_PREFIX)) return path

  const resolved = win32.resolve(path)
  if (resolved.startsWith(UNC_PREFIX)) return `${EXTENDED_PREFIX}UNC\\${resolved.slice(2)}`
  return `${EXTENDED_PREFIX}${resolved}`
}
