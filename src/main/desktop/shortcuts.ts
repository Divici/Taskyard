import { dirname } from 'node:path'
import { expandEnvVars, type Env } from './env-vars'
import { LnkParseError, lnkLocality, parseLnk, resolveLnk } from './lnk-parser'

/** The fields of Electron's `ShortcutDetails` Taskyard reads. */
export interface ShortcutDetails {
  target: string
  icon?: string
  iconIndex?: number
}

export interface ShortcutDeps {
  readFile: (path: string) => Promise<Buffer>
  /**
   * Electron's `shell.readShortcutLink` (synchronous COM on the main thread). Called only for a
   * link the parser could not give a path for AND could prove is not on the network: a dead UNC
   * target can block it for seconds (Decision 12).
   */
  readShortcutLink?: (path: string) => ShortcutDetails
  env: Env
  log: { warn(message: string, ...details: unknown[]): void }
}

/** What a shortcut adds to its DesktopItem. */
export interface ShortcutInfo {
  targetPath?: string
  targetRemote?: boolean
  url?: string
  iconPath?: string
  iconIndex?: number
}

/** `[InternetShortcut]` of a `.url` file. */
export interface UrlFile {
  url?: string
  iconFile?: string
  iconIndex?: number
}

function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.toString('utf16le', 2)
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.toString('utf8', 3)
  }
  return bytes.toString('utf8')
}

/** Reads URL, IconFile and IconIndex from the `[InternetShortcut]` section (keys any case). */
export function parseUrlFile(bytes: Buffer): UrlFile {
  const result: UrlFile = {}
  let inSection = false
  for (const raw of decodeText(bytes).split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inSection = line.toLowerCase() === '[internetshortcut]'
      continue
    }
    const equals = line.indexOf('=')
    if (!inSection || equals <= 0) continue
    const key = line.slice(0, equals).trim().toLowerCase()
    const value = line.slice(equals + 1).trim()
    if (key === 'url' && value) result.url = value
    else if (key === 'iconfile' && value) result.iconFile = value
    else if (key === 'iconindex' && /^-?\d+$/.test(value)) result.iconIndex = Number(value)
  }
  return result
}

function isNetworkPath(path: string): boolean {
  return path.startsWith('\\\\') && !/^\\\\[?.]\\[a-z]:/i.test(path)
}

function fromShell(path: string, deps: ShortcutDeps): ShortcutInfo | null {
  if (!deps.readShortcutLink) return null
  try {
    const details = deps.readShortcutLink(path)
    const info: ShortcutInfo = {}
    if (details.target) {
      info.targetPath = details.target
      info.targetRemote = isNetworkPath(details.target)
    }
    if (details.icon) info.iconPath = details.icon
    if (details.iconIndex !== undefined) info.iconIndex = details.iconIndex
    return info
  } catch (error) {
    deps.log.warn(`shortcuts: shell.readShortcutLink failed for ${path}`, error)
    return null
  }
}

async function readLnk(path: string, deps: ShortcutDeps): Promise<ShortcutInfo> {
  const bytes = await deps.readFile(path)
  try {
    const resolved = resolveLnk(parseLnk(bytes), { lnkDir: dirname(path), env: deps.env })
    const info: ShortcutInfo = {
      targetRemote: resolved.targetRemote,
      iconIndex: resolved.iconIndex
    }
    if (resolved.targetPath !== undefined) info.targetPath = resolved.targetPath
    if (resolved.iconPath !== undefined) info.iconPath = resolved.iconPath
    if (info.targetPath !== undefined || resolved.targetRemote) return info
    // No path in the file (IDList-only, advertised MSI links) and nothing network about it.
    const shell = fromShell(path, deps)
    return shell ? { ...info, ...shell } : info
  } catch (error) {
    if (!(error instanceof LnkParseError)) throw error
    deps.log.warn(`shortcuts: could not parse ${path}: ${error.message}`, error)
    const { remote, local } = lnkLocality(error.partial)
    if (remote) return { targetRemote: true }
    // Only what was read before the problem proved the target local is the fallback safe.
    return (local && fromShell(path, deps)) || {}
  }
}

async function readUrl(path: string, deps: ShortcutDeps): Promise<ShortcutInfo> {
  const parsed = parseUrlFile(await deps.readFile(path))
  const info: ShortcutInfo = {}
  if (parsed.url !== undefined) info.url = parsed.url
  if (parsed.iconFile !== undefined) info.iconPath = expandEnvVars(parsed.iconFile, deps.env)
  if (parsed.iconIndex !== undefined) info.iconIndex = parsed.iconIndex
  return info
}

/**
 * A shortcut's target, URL and icon from its own bytes (the caller never passes a cloud
 * placeholder: reading it would download it). Never throws: an unreadable file is logged and
 * yields nothing.
 */
export async function readShortcut(
  path: string,
  kind: 'link' | 'url',
  deps: ShortcutDeps
): Promise<ShortcutInfo> {
  try {
    return kind === 'link' ? await readLnk(path, deps) : await readUrl(path, deps)
  } catch (error) {
    deps.log.warn(`shortcuts: could not read ${path}`, error)
    return {}
  }
}
