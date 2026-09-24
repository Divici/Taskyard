/**
 * Parses a Win32 environment block (`CreateEnvironmentBlock`): `NAME=value` entries separated
 * by NUL and ended by an empty entry. Per-drive working-directory entries (`=C:=C:\…`) are
 * dropped; they are not variables.
 */
export function parseEnvironmentBlock(block: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of block.split('\0')) {
    if (entry === '') break
    const separator = entry.indexOf('=', 1)
    if (entry.startsWith('=') || separator < 0) continue
    env[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return env
}
