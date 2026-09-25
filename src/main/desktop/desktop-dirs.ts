import { win32 } from 'node:path'
import { ENV } from '../app/env'

type Env = Partial<Record<string, string | undefined>>

/** The shared desktop every user sees (`%PUBLIC%\Desktop`, normally C:\Users\Public\Desktop). */
export function publicDesktopDir(env: Env): string {
  return win32.join(env['PUBLIC'] ?? 'C:\\Users\\Public', 'Desktop')
}

function normalize(dir: string): string {
  const resolved = win32.resolve(dir)
  // resolve keeps the separator of a root ("C:\"); strip any other trailing one.
  return /^[a-z]:\\$/i.test(resolved) ? resolved : resolved.replace(/\\+$/, '')
}

/**
 * The folders whose union is the Windows desktop: the user's Desktop first (moves land there),
 * then the Public Desktop. `TASKYARD_DESKTOP_DIRS` (a semicolon list; tests point it at temp
 * folders) replaces both, its first entry playing the user Desktop. Duplicates are dropped
 * case-insensitively, as NTFS compares names.
 */
export function resolveDesktopDirs(options: { env: Env; userDesktop: string }): string[] {
  const override = (options.env[ENV.desktopDirs] ?? '')
    .split(';')
    .map((dir) => dir.trim())
    .filter(Boolean)
  const dirs = override.length > 0 ? override : [options.userDesktop, publicDesktopDir(options.env)]
  const seen = new Set<string>()
  const unique: string[] = []
  for (const dir of dirs.map(normalize)) {
    const key = dir.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(dir)
  }
  return unique
}
