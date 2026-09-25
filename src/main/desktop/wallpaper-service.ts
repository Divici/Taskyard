import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { win32 as winPath } from 'node:path'
import { watch } from 'chokidar'
import type { WallpaperChanged, WallpaperHint, WallpaperInfo } from '@shared/ipc'
import type { Rect } from '@shared/schema'
import { virtualScreenOf } from '@shared/wallpaper-geometry'
import type { MonitorWallpaper, PixelRect, Win32Api } from '../win32/api'
import {
  displayRectPx,
  parseDesktopColor,
  resolveWallpaperImage,
  type ResolvedWallpaperImage,
  type WallpaperFs
} from '../win32/wallpaper'

// Main's side of the wallpaper layer: resolves every display's wallpaper, serves the image over
// `taskyard://wallpaper/<displayId>?v=<n>`, and bumps `v` (broadcast as `wallpaper:changed`)
// whenever what Windows paints changes. Changes are noticed three ways, cheapest first:
// WM_SETTINGCHANGE (Settings app, SPI_SETDESKWALLPAPER), a write in the Themes folder (slideshow
// advance, Spotlight rotation: Windows rewrites its transcoded copies) and a 60 s poll.

/** The app's privileged scheme (registered before `ready`; see `TASKYARD_SCHEME_PRIVILEGES`). */
export const TASKYARD_SCHEME = 'taskyard'
export const WALLPAPER_HOST = 'wallpaper'
/**
 * `standard` gives the scheme real URLs (host + path), `secure` lets an https-like page use it,
 * `supportFetchAPI` lets `protocol.handle` answer with a `Response`.
 */
export const TASKYARD_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true
} as const

/** The catch-all poll for changes no event announced. */
export const WALLPAPER_POLL_MS = 60_000
/**
 * WM_SETTINGCHANGE reaches every desktop window and a transcode writes several files: one
 * refresh this long after the last of them (well inside the 2 s budget).
 */
export const SETTING_CHANGE_DEBOUNCE_MS = 250

export function wallpaperUrl(displayId: number, version: number): string {
  return `${TASKYARD_SCHEME}://${WALLPAPER_HOST}/${displayId}?v=${version}`
}

/** The display id in a `taskyard://wallpaper/<id>` URL, or null for anything else. */
export function parseWallpaperUrl(url: string): number | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${TASKYARD_SCHEME}:` || parsed.hostname !== WALLPAPER_HOST) return null
  const match = /^\/(\d+)\/?$/.exec(parsed.pathname)
  if (!match) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

/** The fields of an Electron `Display` the service uses. */
export interface WallpaperDisplay {
  id: number
  bounds: Rect
  scaleFactor: number
}

export interface WallpaperServiceFs extends WallpaperFs {
  /** Null when `path` cannot be read. */
  stat(path: string): { mtimeMs: number; size: number } | null
  readFile(path: string): Promise<Buffer>
}

export interface WallpaperWatch {
  close(): Promise<void>
}

export interface WallpaperServiceDeps {
  api: Pick<Win32Api, 'getWallpaperForMonitor' | 'regGetString'>
  /** Every attached display right now (Electron's `screen.getAllDisplays()`). */
  displays: () => readonly WallpaperDisplay[]
  /** Electron's `screen.dipToScreenRect(null, bounds)`: exact physical pixels at mixed DPI. */
  toScreenRect?: (bounds: Rect) => PixelRect
  /** `%APPDATA%\Microsoft\Windows\Themes`: Windows' transcoded wallpaper copies. */
  themesDir: string
  fs: WallpaperServiceFs
  emit: (payload: WallpaperChanged) => void
  log: {
    info(message: string, ...details: unknown[]): void
    warn(message: string, ...details: unknown[]): void
  }
  /** Watches the Themes folder; `onChange` on any write in it. */
  watchThemes?: (dir: string, onChange: () => void) => Promise<WallpaperWatch>
  pollMs?: number
  debounceMs?: number
}

export interface WallpaperService {
  /** The display's wallpaper (resolved on first use); null when no such display is attached. */
  describe(displayId: number): WallpaperInfo | null
  /** Re-reads every display now; bumps and broadcasts the ones that changed. */
  refresh(): void
  /** Something changed somewhere (WM_SETTINGCHANGE): refresh shortly. */
  settingChanged(): void
  /** The `taskyard://` protocol handler: the display's image, or 404. */
  handle(url: string): Promise<Response>
  /** Starts the Themes-folder watch and the poll. */
  start(): Promise<void>
  stop(): Promise<void>
}

interface DisplayState {
  version: number
  signature: string
  info: Omit<WallpaperInfo, 'version' | 'url'>
  file: string | null
  mime: string | null
  /** What was last logged about this display (one line per change). */
  logged: string
}

const DESKTOP_COLOR = { key: 'Control Panel\\Colors', value: 'Background' } as const

export function createWallpaperService(deps: WallpaperServiceDeps): WallpaperService {
  const { api, fs, log } = deps
  const pollMs = deps.pollMs ?? WALLPAPER_POLL_MS
  const debounceMs = deps.debounceMs ?? SETTING_CHANGE_DEBOUNCE_MS
  const states = new Map<number, DisplayState>()
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let watcher: WallpaperWatch | null = null
  let running = false

  const readColor = (): string => {
    try {
      return parseDesktopColor(api.regGetString('HKCU', DESKTOP_COLOR.key, DESKTOP_COLOR.value))
    } catch {
      return parseDesktopColor(null)
    }
  }

  const fileStamp = (path: string | null): string => {
    if (path === null) return '-'
    const stat = fs.stat(path)
    return stat ? `${stat.mtimeMs}:${stat.size}` : 'missing'
  }

  type Computed = Omit<DisplayState, 'version' | 'logged'> & { resolved: ResolvedWallpaperImage }

  /** Resolves one display; throws when `read` (Win32) does. */
  const compute = (
    display: WallpaperDisplay,
    virtualRectPx: PixelRect,
    color: string,
    read: (rectPx: PixelRect) => MonitorWallpaper | null = (rectPx) =>
      api.getWallpaperForMonitor(rectPx)
  ): Computed => {
    const displayRect = displayRectPx(display, deps.toScreenRect)
    const wallpaper = read(displayRect)
    const resolved = resolveWallpaperImage(wallpaper, { fs, themesDir: deps.themesDir })
    const info: DisplayState['info'] = {
      displayId: display.id,
      position: wallpaper?.position ?? 'fill',
      color,
      scaleFactor: display.scaleFactor,
      displayRectPx: displayRect,
      virtualRectPx,
      hint: resolved.hint
    }
    const signature = JSON.stringify([
      info,
      resolved.source,
      fileStamp(resolved.source),
      resolved.file,
      fileStamp(resolved.file)
    ])
    return { signature, info, file: resolved.file, mime: resolved.mime, resolved }
  }

  const describeLine = (
    id: number,
    resolved: ResolvedWallpaperImage,
    info: DisplayState['info']
  ): {
    level: 'info' | 'warn'
    line: string
  } => {
    const why = resolved.reason === 'missing' ? 'is missing' : 'cannot be decoded'
    const hint: WallpaperHint | null = resolved.hint
    switch (hint) {
      case null:
        return {
          level: 'info',
          line: `wallpaper: display ${id} shows ${resolved.file} (${info.position})`
        }
      case 'solid-color':
        return {
          level: 'info',
          line: `wallpaper: display ${id} has no picture; painting the desktop colour ${info.color}`
        }
      case 'transcoded':
        return {
          level: 'warn',
          line: `wallpaper: display ${id}: ${resolved.source} ${why}; showing Windows' converted copy ${winPath.basename(resolved.file ?? '')}`
        }
      case 'color-fallback':
        return {
          level: 'warn',
          line: `wallpaper: display ${id}: ${resolved.source} ${why} and Windows has no usable converted copy; painting the desktop colour ${info.color}`
        }
      case 'unavailable':
        return {
          level: 'warn',
          line: `wallpaper: display ${id}: the Windows wallpaper could not be read; painting the desktop colour ${info.color}`
        }
    }
  }

  /** Logs a display's state once per change of what it shows. */
  const logState = (state: DisplayState, resolved: ResolvedWallpaperImage): void => {
    const key = JSON.stringify([resolved.hint, resolved.file, resolved.source, state.info.position])
    if (state.logged === key) return
    state.logged = key
    const { level, line } = describeLine(state.info.displayId, resolved, state.info)
    log[level](line)
  }

  const virtualOf = (displays: readonly WallpaperDisplay[]): PixelRect =>
    virtualScreenOf(displays.map((display) => displayRectPx(display, deps.toScreenRect)))

  /** The state of `displayId`, resolving it on first use; null when it is not attached. */
  const ensure = (displayId: number): DisplayState | null => {
    const displays = deps.displays()
    const display = displays.find((d) => d.id === displayId)
    if (display === undefined) {
      states.delete(displayId)
      return null
    }
    const known = states.get(displayId)
    if (known) return known
    const color = readColor()
    const virtualRectPx = virtualOf(displays)
    let next: Computed
    try {
      next = compute(display, virtualRectPx, color)
    } catch (error) {
      log.warn(`wallpaper: reading display ${displayId}'s wallpaper failed`, error)
      next = compute(display, virtualRectPx, color, () => null)
    }
    const state: DisplayState = {
      version: 1,
      signature: next.signature,
      info: next.info,
      file: next.file,
      mime: next.mime,
      logged: ''
    }
    states.set(displayId, state)
    logState(state, next.resolved)
    return state
  }

  const toInfo = (state: DisplayState): WallpaperInfo => ({
    displayId: state.info.displayId,
    version: state.version,
    url: state.file === null ? null : wallpaperUrl(state.info.displayId, state.version),
    position: state.info.position,
    color: state.info.color,
    scaleFactor: state.info.scaleFactor,
    displayRectPx: { ...state.info.displayRectPx },
    virtualRectPx: { ...state.info.virtualRectPx },
    hint: state.info.hint
  })

  const refresh = (): void => {
    const displays = deps.displays()
    const attached = new Set(displays.map((display) => display.id))
    for (const id of [...states.keys()]) if (!attached.has(id)) states.delete(id)
    const virtualRectPx = virtualOf(displays)
    const color = readColor()
    for (const display of displays) {
      const state = states.get(display.id)
      // Never described: the window asks for it when it loads.
      if (state === undefined) continue
      let next: Computed
      try {
        next = compute(display, virtualRectPx, color)
      } catch (error) {
        // Keep showing what we had; the next trigger tries again.
        log.warn('wallpaper: refresh failed', error)
        continue
      }
      if (next.signature === state.signature) continue
      state.version += 1
      state.signature = next.signature
      state.info = next.info
      state.file = next.file
      state.mime = next.mime
      logState(state, next.resolved)
      deps.emit({ displayId: display.id, version: state.version })
    }
  }

  const settingChanged = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      refresh()
    }, debounceMs)
  }

  const notFound = (): Response => new Response(null, { status: 404 })

  return {
    describe(displayId) {
      const state = ensure(displayId)
      return state ? toInfo(state) : null
    },

    refresh,
    settingChanged,

    async handle(url) {
      const displayId = parseWallpaperUrl(url)
      if (displayId === null) return notFound()
      let state: DisplayState | null
      try {
        state = ensure(displayId)
      } catch {
        return notFound()
      }
      if (state === null || state.file === null || state.mime === null) return notFound()
      try {
        const body = await fs.readFile(state.file)
        return new Response(new Uint8Array(body), {
          status: 200,
          headers: { 'content-type': state.mime, 'cache-control': 'no-cache' }
        })
      } catch (error) {
        log.warn(`wallpaper: reading ${state.file} for display ${displayId} failed`, error)
        return notFound()
      }
    },

    async start() {
      if (running) return
      running = true
      pollTimer = setInterval(refresh, pollMs)
      if (deps.watchThemes) {
        try {
          const opened = await deps.watchThemes(deps.themesDir, settingChanged)
          if (running) watcher = opened
          else await opened.close()
        } catch (error) {
          log.warn(
            `wallpaper: cannot watch ${deps.themesDir}; relying on WM_SETTINGCHANGE and the poll`,
            error
          )
        }
      }
    },

    async stop() {
      running = false
      if (pollTimer !== null) clearInterval(pollTimer)
      pollTimer = null
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = null
      const closing = watcher
      watcher = null
      await closing?.close()
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Real file system and Themes-folder watch

export const nodeWallpaperFs: WallpaperServiceFs = {
  head(path, bytes) {
    let fd: number | null = null
    try {
      fd = openSync(path, 'r')
      const buffer = Buffer.alloc(bytes)
      const read = readSync(fd, buffer, 0, bytes, 0)
      return buffer.subarray(0, read)
    } catch {
      return null
    } finally {
      if (fd !== null) closeSync(fd)
    }
  },
  stat(path) {
    try {
      const stat = statSync(path)
      return stat.isFile() ? { mtimeMs: stat.mtimeMs, size: stat.size } : null
    } catch {
      return null
    }
  },
  readFile: (path) => readFile(path)
}

/** chokidar on the Themes folder's direct children (the transcoded copies). */
export async function watchThemesFolder(
  dir: string,
  onChange: () => void
): Promise<WallpaperWatch> {
  const watcher = watch(dir, { ignoreInitial: true, depth: 0, persistent: true })
  for (const event of ['add', 'change', 'unlink'] as const) watcher.on(event, onChange)
  await new Promise<void>((resolve, reject) => {
    watcher.once('ready', () => resolve())
    watcher.once('error', reject)
  })
  return { close: () => watcher.close() }
}
