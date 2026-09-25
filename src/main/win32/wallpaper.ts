import { win32 as winPath } from 'node:path'
import type { WallpaperHint } from '@shared/ipc'
import type { Rect } from '@shared/schema'
import { IMAGE_SNIFF_BYTES, sniffImage, type ImageMime } from '../desktop/image-sniff'
import type { MonitorWallpaper, PixelRect, WallpaperPosition } from './api'
import type { Koffi } from './bindings'
import { checkHr, type ComRuntime } from './com'

// Reading what Windows paints on each monitor. Read only: nothing here ever sets a wallpaper.
//
// 1. IDesktopWallpaper (per monitor): device paths, each monitor's RECT in physical pixels, its
//    image path, and the one global position (fill/fit/…).
// 2. Fallback when COM fails: SPI_GETDESKWALLPAPER + HKCU\Control Panel\Desktop WallpaperStyle /
//    TileWallpaper (one wallpaper for every monitor).
// 3. The image file itself is content-sniffed; one Chromium cannot decode (HDR .jxr) or that is
//    gone falls back to Windows' own converted copy, Themes\Transcoded_00N, then to the colour.

export const CLSID_DESKTOP_WALLPAPER = '{C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD}'
export const IID_IDESKTOP_WALLPAPER = '{B92B56A9-8B55-4E14-9A89-0199BBB6F93B}'

/** IDesktopWallpaper vtable slots (after IUnknown's 0–2), from ShObjIdl_core.h. */
export const DESKTOP_WALLPAPER = {
  GetWallpaper: 4,
  GetMonitorDevicePathAt: 5,
  GetMonitorDevicePathCount: 6,
  GetMonitorRECT: 7,
  GetPosition: 11
} as const

/** DESKTOP_WALLPAPER_POSITION values 0–5. */
const POSITIONS: readonly WallpaperPosition[] = ['center', 'tile', 'stretch', 'fit', 'fill', 'span']

/** koffi prototypes of the IDesktopWallpaper methods used (each with `this` first). */
export interface DesktopWallpaperProtos {
  getWallpaper: unknown
  getMonitorDevicePathAt: unknown
  getMonitorDevicePathCount: unknown
  getMonitorRect: unknown
  getPosition: unknown
}

export function desktopWallpaperProtos(koffi: Koffi): DesktopWallpaperProtos {
  const RECT = koffi.struct({ left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const outPointer = koffi.out(koffi.pointer('void *'))
  return {
    // HRESULT GetWallpaper(LPCWSTR monitorID, LPWSTR *wallpaper)
    getWallpaper: koffi.proto('__stdcall', null, 'long', ['void *', 'str16', outPointer]),
    // HRESULT GetMonitorDevicePathAt(UINT monitorIndex, LPWSTR *monitorID)
    getMonitorDevicePathAt: koffi.proto('__stdcall', null, 'long', [
      'void *',
      'uint32_t',
      outPointer
    ]),
    // HRESULT GetMonitorDevicePathCount(UINT *count)
    getMonitorDevicePathCount: koffi.proto('__stdcall', null, 'long', [
      'void *',
      koffi.out(koffi.pointer('uint32_t'))
    ]),
    // HRESULT GetMonitorRECT(LPCWSTR monitorID, RECT *displayRect)
    getMonitorRect: koffi.proto('__stdcall', null, 'long', [
      'void *',
      'str16',
      koffi.out(koffi.pointer(RECT))
    ]),
    // HRESULT GetPosition(DESKTOP_WALLPAPER_POSITION *position)
    getPosition: koffi.proto('__stdcall', null, 'long', ['void *', koffi.out(koffi.pointer('int'))])
  }
}

/** One monitor as IDesktopWallpaper lists it. `rect` is null for a monitor not attached now. */
export interface DesktopMonitor {
  /** Position in IDesktopWallpaper's list (selects `Transcoded_00N`). */
  index: number
  id: string
  rect: PixelRect | null
  /** Null when the monitor shows no picture (an empty path). */
  path: string | null
}

export interface DesktopWallpaperSnapshot {
  monitors: DesktopMonitor[]
  position: WallpaperPosition
}

export interface DesktopWallpaperReader {
  read(): DesktopWallpaperSnapshot
  /** Releases the COM object (a later read creates a new one). */
  dispose(): void
}

interface NativeRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * IDesktopWallpaper through vtable calls. One instance is kept between reads; any failed call
 * releases it and the next read creates a fresh one (Explorer may have restarted).
 */
export function createDesktopWallpaperReader(
  com: ComRuntime,
  protos: DesktopWallpaperProtos
): DesktopWallpaperReader {
  let instance: bigint | null = null

  const dispose = (): void => {
    if (instance === null) return
    const self = instance
    instance = null
    com.release(self)
  }

  const readMonitor = (self: bigint, index: number): DesktopMonitor => {
    const idOut: [bigint | null] = [null]
    checkHr(
      com.call(
        self,
        DESKTOP_WALLPAPER.GetMonitorDevicePathAt,
        protos.getMonitorDevicePathAt,
        index,
        idOut
      ),
      'IDesktopWallpaper::GetMonitorDevicePathAt'
    )
    const id = com.takeString(idOut[0]) ?? ''

    const native: NativeRect = { left: 0, top: 0, right: 0, bottom: 0 }
    // Fails for monitors IDesktopWallpaper remembers but that are not attached now.
    const rectHr = com.call(
      self,
      DESKTOP_WALLPAPER.GetMonitorRECT,
      protos.getMonitorRect,
      id,
      native
    )
    const rect =
      rectHr >= 0
        ? {
            x: native.left,
            y: native.top,
            width: native.right - native.left,
            height: native.bottom - native.top
          }
        : null

    const pathOut: [bigint | null] = [null]
    checkHr(
      com.call(self, DESKTOP_WALLPAPER.GetWallpaper, protos.getWallpaper, id, pathOut),
      'IDesktopWallpaper::GetWallpaper'
    )
    const path = com.takeString(pathOut[0])
    return { index, id, rect, path: path ? path : null }
  }

  return {
    read() {
      try {
        instance ??= com.createInstance(CLSID_DESKTOP_WALLPAPER, IID_IDESKTOP_WALLPAPER)
        const self = instance
        const count: [number] = [0]
        checkHr(
          com.call(
            self,
            DESKTOP_WALLPAPER.GetMonitorDevicePathCount,
            protos.getMonitorDevicePathCount,
            count
          ),
          'IDesktopWallpaper::GetMonitorDevicePathCount'
        )
        const monitors: DesktopMonitor[] = []
        for (let index = 0; index < count[0]; index++) monitors.push(readMonitor(self, index))
        const position: [number] = [0]
        checkHr(
          com.call(self, DESKTOP_WALLPAPER.GetPosition, protos.getPosition, position),
          'IDesktopWallpaper::GetPosition'
        )
        return { monitors, position: POSITIONS[position[0]] ?? 'fill' }
      } catch (error) {
        dispose()
        throw error
      }
    },
    dispose
  }
}

// ---------------------------------------------------------------------------------------------
// Monitor matching

/** A display's rectangle in physical pixels (what IDesktopWallpaper's RECTs use). */
export function displayRectPx(
  display: { bounds: Rect; scaleFactor: number },
  toScreenRect?: (bounds: Rect) => PixelRect
): PixelRect {
  if (toScreenRect) return toScreenRect(display.bounds)
  const { bounds, scaleFactor } = display
  return {
    x: Math.round(bounds.x * scaleFactor),
    y: Math.round(bounds.y * scaleFactor),
    width: Math.round(bounds.width * scaleFactor),
    height: Math.round(bounds.height * scaleFactor)
  }
}

function overlapArea(a: PixelRect, b: PixelRect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

/**
 * The monitor showing `rectPx`: the exact RECT, else the one it overlaps most (DIP → pixel
 * rounding at 125/150 % can be off by a pixel). Detached monitors never match.
 */
export function matchMonitor(
  monitors: readonly DesktopMonitor[],
  rectPx: PixelRect
): DesktopMonitor | null {
  const attached = monitors.filter(
    (m): m is DesktopMonitor & { rect: PixelRect } => m.rect !== null
  )
  const exact = attached.find(
    ({ rect }) =>
      rect.x === rectPx.x &&
      rect.y === rectPx.y &&
      rect.width === rectPx.width &&
      rect.height === rectPx.height
  )
  if (exact) return exact
  let best: DesktopMonitor | null = null
  let bestArea = 0
  for (const monitor of attached) {
    const area = overlapArea(monitor.rect, rectPx)
    if (area > bestArea) {
      best = monitor
      bestArea = area
    }
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// Legacy fallback (one wallpaper for all monitors)

export interface LegacyWallpaper {
  /** SPI_GETDESKWALLPAPER; empty or null when there is no picture. */
  path: string | null
  /** HKCU\Control Panel\Desktop WallpaperStyle and TileWallpaper. */
  style: string | null
  tile: string | null
}

/** WallpaperStyle/TileWallpaper as the Settings app writes them. */
export function positionFromRegistry(style: string | null, tile: string | null): WallpaperPosition {
  switch (Number(style ?? '10')) {
    case 0:
      return tile === '1' ? 'tile' : 'center'
    case 2:
      return 'stretch'
    case 6:
      return 'fit'
    case 22:
      return 'span'
    default:
      return 'fill'
  }
}

export interface MonitorWallpaperReaderDeps {
  /** Creates the IDesktopWallpaper reader (may throw: COM unavailable). */
  reader: () => DesktopWallpaperReader
  legacy: () => LegacyWallpaper
  log: { warn(message: string, ...details: unknown[]): void }
}

/**
 * `Win32Api.getWallpaperForMonitor`: IDesktopWallpaper's answer for the monitor at `rectPx`,
 * else the legacy one-wallpaper-for-all answer. A COM failure is logged once until COM works
 * again.
 */
export function createMonitorWallpaperReader(
  deps: MonitorWallpaperReaderDeps
): (rectPx: PixelRect) => MonitorWallpaper {
  let reader: DesktopWallpaperReader | null = null
  let warned = false

  const legacy = (): MonitorWallpaper => {
    const { path, style, tile } = deps.legacy()
    return {
      path: path ? path : null,
      position: positionFromRegistry(style, tile),
      monitorIndex: 0
    }
  }

  return (rectPx) => {
    let snapshot: DesktopWallpaperSnapshot
    try {
      reader ??= deps.reader()
      snapshot = reader.read()
      warned = false
    } catch (error) {
      if (!warned) {
        warned = true
        deps.log.warn(
          'wallpaper: IDesktopWallpaper failed; reading SPI_GETDESKWALLPAPER and WallpaperStyle instead',
          error
        )
      }
      return legacy()
    }
    const monitor = matchMonitor(snapshot.monitors, rectPx)
    if (monitor === null) return legacy()
    return { path: monitor.path, position: snapshot.position, monitorIndex: monitor.index }
  }
}

// ---------------------------------------------------------------------------------------------
// Image resolution

export interface WallpaperFs {
  /** The first `bytes` bytes of `path`, or null when it cannot be read (missing, locked). */
  head(path: string, bytes: number): Buffer | null
}

export interface ResolvedWallpaperImage {
  /** The file to serve, or null: colour only. */
  file: string | null
  mime: ImageMime | null
  hint: WallpaperHint | null
  /** Why the source was not shown (with the `transcoded` and `color-fallback` hints). */
  reason?: 'undecodable' | 'missing'
  /** The picture Windows was asked to show. */
  source: string | null
}

/** Windows' converted copy of monitor `index`'s wallpaper: `Themes\Transcoded_00N`. */
export function transcodedPath(themesDir: string, index: number): string {
  return winPath.join(themesDir, `Transcoded_${String(index).padStart(3, '0')}`)
}

/**
 * The file to show for `wallpaper` (null = Win32 could not say): the source when Chromium can
 * decode it (by content), else `Transcoded_00N` for that monitor, else the colour.
 */
export function resolveWallpaperImage(
  wallpaper: MonitorWallpaper | null,
  { fs, themesDir }: { fs: WallpaperFs; themesDir: string }
): ResolvedWallpaperImage {
  if (wallpaper === null) return { file: null, mime: null, hint: 'unavailable', source: null }
  const source = wallpaper.path
  if (source === null) return { file: null, mime: null, hint: 'solid-color', source: null }

  const sniff = (path: string): { mime: ImageMime | null; exists: boolean } => {
    const head = fs.head(path, IMAGE_SNIFF_BYTES)
    return { mime: head === null ? null : sniffImage(head), exists: head !== null }
  }

  const direct = sniff(source)
  if (direct.mime !== null) return { file: source, mime: direct.mime, hint: null, source }

  const reason = direct.exists ? 'undecodable' : 'missing'
  const cache = transcodedPath(themesDir, wallpaper.monitorIndex)
  const cached = sniff(cache)
  if (cached.mime !== null) {
    return { file: cache, mime: cached.mime, hint: 'transcoded', reason, source }
  }
  return { file: null, mime: null, hint: 'color-fallback', reason, source }
}

/** HKCU\Control Panel\Colors\Background ("R G B") as `#rrggbb`; black when unusable. */
export function parseDesktopColor(value: string | null): string {
  const parts = (value ?? '').trim().split(/\s+/)
  if (parts.length !== 3) return '#000000'
  const channels = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  if (channels.some((channel) => !(channel >= 0 && channel <= 255))) return '#000000'
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}
