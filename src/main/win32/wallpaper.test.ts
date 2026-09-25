import { describe, expect, it, vi } from 'vitest'
import type { PixelRect } from './api'
import { ComError, type ComRuntime } from './com'
import {
  createDesktopWallpaperReader,
  createMonitorWallpaperReader,
  DESKTOP_WALLPAPER,
  displayRectPx,
  matchMonitor,
  parseDesktopColor,
  positionFromRegistry,
  resolveWallpaperImage,
  transcodedPath,
  type DesktopMonitor,
  type DesktopWallpaperProtos,
  type WallpaperFs
} from './wallpaper'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
const JXR = Buffer.from([0x49, 0x49, 0xbc, 0x01, 0x08, 0, 0, 0, 0, 0, 0, 0])
const THEMES = 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Themes'

// ---------------------------------------------------------------------------------------------
// A fake IDesktopWallpaper behind a fake COM runtime: vtable calls fill their out-parameters the
// way koffi does (`[value]` arrays for pointers, an object for the RECT).

interface FakeMonitor {
  id: string
  rect: PixelRect | null
  path: string
}

function fakeCom(
  monitors: FakeMonitor[],
  position = 3
): {
  com: ComRuntime
  released: bigint[]
  created: number
  fail(index: number, hr: number): void
  heal(index: number): void
} {
  const failures = new Map<number, number>()
  const strings = new Map<bigint, string>()
  let nextString = 0x100n
  const released: bigint[] = []
  const state = { created: 0 }
  const alloc = (text: string): bigint => {
    const pointer = nextString++
    strings.set(pointer, text)
    return pointer
  }
  const byId = (id: string): FakeMonitor | undefined => monitors.find((m) => m.id === id)

  const com: ComRuntime = {
    createInstance: vi.fn(() => {
      state.created += 1
      return 0x7000n + BigInt(state.created)
    }),
    release: vi.fn((self: bigint) => {
      released.push(self)
    }),
    takeString: vi.fn((pointer: bigint | null) => {
      if (pointer === null) return null
      const text = strings.get(pointer)
      strings.delete(pointer)
      return text ?? null
    }),
    call: vi.fn((_self: bigint, index: number, _proto: unknown, ...args: unknown[]) => {
      const failure = failures.get(index)
      if (failure !== undefined) return failure
      switch (index) {
        case DESKTOP_WALLPAPER.GetMonitorDevicePathCount:
          ;(args[0] as [number])[0] = monitors.length
          return 0
        case DESKTOP_WALLPAPER.GetMonitorDevicePathAt:
          ;(args[1] as [bigint | null])[0] = alloc(monitors[args[0] as number].id)
          return 0
        case DESKTOP_WALLPAPER.GetMonitorRECT: {
          const rect = byId(args[0] as string)?.rect
          if (!rect) return 0x80070490 | 0 // ERROR_NOT_FOUND: a detached monitor
          Object.assign(args[1] as object, {
            left: rect.x,
            top: rect.y,
            right: rect.x + rect.width,
            bottom: rect.y + rect.height
          })
          return 0
        }
        case DESKTOP_WALLPAPER.GetWallpaper:
          ;(args[1] as [bigint | null])[0] = alloc(byId(args[0] as string)?.path ?? '')
          return 0
        case DESKTOP_WALLPAPER.GetPosition:
          ;(args[0] as [number])[0] = position
          return 0
        default:
          throw new Error(`unexpected vtable slot ${index}`)
      }
    })
  }
  return {
    com,
    released,
    get created() {
      return state.created
    },
    fail: (index, hr) => {
      failures.set(index, hr)
    },
    heal: (index) => {
      failures.delete(index)
    }
  }
}

const PROTOS: DesktopWallpaperProtos = {
  getWallpaper: 'GetWallpaper',
  getMonitorDevicePathAt: 'GetMonitorDevicePathAt',
  getMonitorDevicePathCount: 'GetMonitorDevicePathCount',
  getMonitorRect: 'GetMonitorRECT',
  getPosition: 'GetPosition'
}

const PRIMARY_PX = { x: 0, y: 0, width: 2560, height: 1440 }
const SECONDARY_PX = { x: 2560, y: 0, width: 1920, height: 1080 }

describe('displayRectPx', () => {
  it('multiplies DIP bounds by the scale factor, rounded to whole pixels', () => {
    // 2560×1440 at 150 % is reported by Electron as 1707×960 DIPs.
    const display = { bounds: { x: 0, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 }
    expect(displayRectPx(display)).toEqual({ x: 0, y: 0, width: 2561, height: 1440 })
  })

  it("prefers Electron's own DIP → screen conversion (mixed-DPI layouts)", () => {
    const display = { bounds: { x: 1707, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
    const toScreen = vi.fn(() => SECONDARY_PX)
    expect(displayRectPx(display, toScreen)).toEqual(SECONDARY_PX)
    expect(toScreen).toHaveBeenCalledWith(display.bounds)
  })
})

describe('matchMonitor', () => {
  const monitors: DesktopMonitor[] = [
    { index: 0, id: 'A', rect: PRIMARY_PX, path: 'a.jpg' },
    { index: 1, id: 'B', rect: SECONDARY_PX, path: 'b.jpg' },
    { index: 2, id: 'C', rect: null, path: 'old.jpg' }
  ]

  it('matches the monitor RECT to a display at 150 % DPI despite DIP rounding', () => {
    const rect = displayRectPx({
      bounds: { x: 0, y: 0, width: 1707, height: 960 },
      scaleFactor: 1.5
    })
    expect(matchMonitor(monitors, rect)?.id).toBe('A')
  })

  it('prefers the exact rect, else the largest overlap; detached monitors never match', () => {
    expect(matchMonitor(monitors, SECONDARY_PX)?.id).toBe('B')
    expect(matchMonitor(monitors, { x: 2500, y: 0, width: 1920, height: 1080 })?.id).toBe('B')
    expect(matchMonitor(monitors, { x: 9000, y: 0, width: 100, height: 100 })).toBeNull()
  })
})

describe('createDesktopWallpaperReader (IDesktopWallpaper over vtable calls)', () => {
  it('lists each monitor with its device path, RECT and wallpaper, plus the global position', () => {
    const fake = fakeCom([
      { id: 'MON-A', rect: PRIMARY_PX, path: 'C:\\art\\wide.jpg' },
      { id: 'MON-B', rect: SECONDARY_PX, path: '' },
      { id: 'MON-GONE', rect: null, path: 'C:\\old.jpg' }
    ])
    const reader = createDesktopWallpaperReader(fake.com, PROTOS)

    expect(reader.read()).toEqual({
      position: 'fit',
      monitors: [
        { index: 0, id: 'MON-A', rect: PRIMARY_PX, path: 'C:\\art\\wide.jpg' },
        { index: 1, id: 'MON-B', rect: SECONDARY_PX, path: null },
        { index: 2, id: 'MON-GONE', rect: null, path: 'C:\\old.jpg' }
      ]
    })
    // Every CoTaskMemAlloc string was handed back (3 ids + 3 paths).
    expect(fake.com.takeString).toHaveBeenCalledTimes(6)
  })

  it('keeps one instance between reads and recreates it after a COM failure', () => {
    const fake = fakeCom([{ id: 'A', rect: PRIMARY_PX, path: 'a.jpg' }])
    const reader = createDesktopWallpaperReader(fake.com, PROTOS)
    reader.read()
    reader.read()
    expect(fake.created).toBe(1)

    fake.fail(DESKTOP_WALLPAPER.GetMonitorDevicePathCount, 0x800706ba | 0) // RPC server gone
    expect(() => reader.read()).toThrow(ComError)
    expect(fake.released).toEqual([0x7001n])

    // Explorer is back: the next read creates a fresh instance.
    fake.heal(DESKTOP_WALLPAPER.GetMonitorDevicePathCount)
    expect(reader.read().monitors).toHaveLength(1)
    expect(fake.created).toBe(2)
  })

  it('maps every DESKTOP_WALLPAPER_POSITION value', () => {
    const names = ['center', 'tile', 'stretch', 'fit', 'fill', 'span']
    names.forEach((name, value) => {
      const reader = createDesktopWallpaperReader(fakeCom([], value).com, PROTOS)
      expect(reader.read().position).toBe(name)
    })
  })

  it('releases the instance on dispose', () => {
    const fake = fakeCom([])
    const reader = createDesktopWallpaperReader(fake.com, PROTOS)
    reader.read()
    reader.dispose()
    reader.dispose()
    expect(fake.released).toEqual([0x7001n])
  })
})

describe('createMonitorWallpaperReader', () => {
  const legacy = {
    path: 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Themes\\TranscodedWallpaper',
    style: '10',
    tile: '0'
  }

  it("answers with the matching monitor's wallpaper and IDesktopWallpaper index", () => {
    const fake = fakeCom(
      [
        { id: 'A', rect: PRIMARY_PX, path: 'C:\\a.jpg' },
        { id: 'B', rect: SECONDARY_PX, path: 'C:\\b.jxr' }
      ],
      4
    )
    const read = createMonitorWallpaperReader({
      reader: () => createDesktopWallpaperReader(fake.com, PROTOS),
      legacy: () => legacy,
      log: { warn: vi.fn() }
    })
    expect(read(SECONDARY_PX)).toEqual({ path: 'C:\\b.jxr', position: 'fill', monitorIndex: 1 })
  })

  it('falls back to SPI_GETDESKWALLPAPER + WallpaperStyle when COM fails, logging once', () => {
    const fake = fakeCom([{ id: 'A', rect: PRIMARY_PX, path: 'C:\\a.jpg' }])
    fake.fail(DESKTOP_WALLPAPER.GetMonitorDevicePathCount, 0x80004005 | 0)
    const log = { warn: vi.fn() }
    const read = createMonitorWallpaperReader({
      reader: () => createDesktopWallpaperReader(fake.com, PROTOS),
      legacy: () => legacy,
      log
    })
    expect(read(PRIMARY_PX)).toEqual({ path: legacy.path, position: 'fill', monitorIndex: 0 })
    read(PRIMARY_PX)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toMatch(/IDesktopWallpaper failed.*SPI_GETDESKWALLPAPER/)
  })

  it('falls back when no monitor matches, and reports an empty legacy path as no picture', () => {
    const fake = fakeCom([{ id: 'A', rect: PRIMARY_PX, path: 'C:\\a.jpg' }])
    const read = createMonitorWallpaperReader({
      reader: () => createDesktopWallpaperReader(fake.com, PROTOS),
      legacy: () => ({ path: '', style: '0', tile: '1' }),
      log: { warn: vi.fn() }
    })
    expect(read({ x: 9000, y: 0, width: 10, height: 10 })).toEqual({
      path: null,
      position: 'tile',
      monitorIndex: 0
    })
  })
})

describe('positionFromRegistry', () => {
  it('maps WallpaperStyle/TileWallpaper like the Settings app writes them', () => {
    expect(positionFromRegistry('0', '1')).toBe('tile')
    expect(positionFromRegistry('0', '0')).toBe('center')
    expect(positionFromRegistry('2', '0')).toBe('stretch')
    expect(positionFromRegistry('6', '0')).toBe('fit')
    expect(positionFromRegistry('10', '0')).toBe('fill')
    expect(positionFromRegistry('22', '0')).toBe('span')
    expect(positionFromRegistry(null, null)).toBe('fill')
  })
})

describe('parseDesktopColor', () => {
  it('turns HKCU\\Control Panel\\Colors\\Background "R G B" into #rrggbb', () => {
    expect(parseDesktopColor('0 99 177')).toBe('#0063b1')
    expect(parseDesktopColor(' 255  255 255 ')).toBe('#ffffff')
  })

  it('falls back to black for a missing or malformed value', () => {
    expect(parseDesktopColor(null)).toBe('#000000')
    expect(parseDesktopColor('red')).toBe('#000000')
    expect(parseDesktopColor('1 2 999')).toBe('#000000')
  })
})

// ---------------------------------------------------------------------------------------------

function memoryFs(files: Record<string, Buffer>): WallpaperFs {
  const find = (path: string): Buffer | undefined =>
    Object.entries(files).find(([name]) => name.toUpperCase() === path.toUpperCase())?.[1]
  return {
    head: vi.fn((path: string, bytes: number) => find(path)?.subarray(0, bytes) ?? null)
  }
}

describe('resolveWallpaperImage', () => {
  it('shows the solid colour when the monitor has no picture (empty path)', () => {
    const resolved = resolveWallpaperImage(
      { path: null, position: 'fill', monitorIndex: 0 },
      { fs: memoryFs({}), themesDir: THEMES }
    )
    expect(resolved).toEqual({ file: null, mime: null, hint: 'solid-color', source: null })
  })

  it('reports Win32 being unavailable as the colour with its own hint', () => {
    const resolved = resolveWallpaperImage(null, { fs: memoryFs({}), themesDir: THEMES })
    expect(resolved).toEqual({ file: null, mime: null, hint: 'unavailable', source: null })
  })

  it('sniffs JPEG content regardless of the file name', () => {
    const fs = memoryFs({ 'C:\\art\\photo.png': JPEG, [`${THEMES}\\TranscodedWallpaper`]: JPEG })
    expect(
      resolveWallpaperImage(
        { path: 'C:\\art\\photo.png', position: 'fit', monitorIndex: 0 },
        { fs, themesDir: THEMES }
      )
    ).toEqual({
      file: 'C:\\art\\photo.png',
      mime: 'image/jpeg',
      hint: null,
      source: 'C:\\art\\photo.png'
    })
    // No extension at all (the legacy path is Windows' own cache file).
    expect(
      resolveWallpaperImage(
        { path: `${THEMES}\\TranscodedWallpaper`, position: 'fit', monitorIndex: 0 },
        { fs, themesDir: THEMES }
      ).mime
    ).toBe('image/jpeg')
  })

  it("falls back from an undecodable .jxr to Windows' Transcoded_00N copy for that monitor", () => {
    const fs = memoryFs({
      'D:\\hdr\\sky.jxr': JXR,
      [transcodedPath(THEMES, 2)]: JPEG
    })
    expect(transcodedPath(THEMES, 2)).toBe(`${THEMES}\\Transcoded_002`)
    expect(
      resolveWallpaperImage(
        { path: 'D:\\hdr\\sky.jxr', position: 'fill', monitorIndex: 2 },
        { fs, themesDir: THEMES }
      )
    ).toEqual({
      file: `${THEMES}\\Transcoded_002`,
      mime: 'image/jpeg',
      hint: 'transcoded',
      reason: 'undecodable',
      source: 'D:\\hdr\\sky.jxr'
    })
  })

  it('uses the transcoded copy when the source file is gone, then the colour', () => {
    const withCache = memoryFs({ [transcodedPath(THEMES, 0)]: JPEG })
    expect(
      resolveWallpaperImage(
        { path: 'C:\\deleted.jpg', position: 'fill', monitorIndex: 0 },
        { fs: withCache, themesDir: THEMES }
      )
    ).toMatchObject({ file: transcodedPath(THEMES, 0), hint: 'transcoded', reason: 'missing' })

    // An undecodable cache (or none) → the desktop colour.
    const noCache = memoryFs({ 'D:\\hdr\\sky.jxr': JXR, [transcodedPath(THEMES, 1)]: JXR })
    expect(
      resolveWallpaperImage(
        { path: 'D:\\hdr\\sky.jxr', position: 'fill', monitorIndex: 1 },
        { fs: noCache, themesDir: THEMES }
      )
    ).toEqual({
      file: null,
      mime: null,
      hint: 'color-fallback',
      reason: 'undecodable',
      source: 'D:\\hdr\\sky.jxr'
    })
  })
})
