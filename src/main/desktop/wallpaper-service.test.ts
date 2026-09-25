import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WallpaperChanged } from '@shared/ipc'
import { createFakeWin32Api, type FakeWin32Api } from '../win32/fake-api'
import {
  createWallpaperService,
  parseWallpaperUrl,
  SETTING_CHANGE_DEBOUNCE_MS,
  WALLPAPER_POLL_MS,
  wallpaperUrl,
  type WallpaperDisplay,
  type WallpaperService,
  type WallpaperServiceFs
} from './wallpaper-service'

const THEMES = 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Themes'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2])
const JXR = Buffer.from([0x49, 0x49, 0xbc, 0x01, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0])

const PRIMARY: WallpaperDisplay = {
  id: 11,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  scaleFactor: 1
}
const SECONDARY: WallpaperDisplay = {
  id: 12,
  bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1
}
const PRIMARY_PX = { x: 0, y: 0, width: 2560, height: 1440 }
const SECONDARY_PX = { x: 2560, y: 0, width: 1920, height: 1080 }

/** An in-memory file system with mtimes, keyed case-insensitively like NTFS. */
function memoryFs(): WallpaperServiceFs & {
  write(path: string, data: Buffer, mtimeMs?: number): void
  remove(path: string): void
} {
  const files = new Map<string, { data: Buffer; mtimeMs: number }>()
  const key = (path: string): string => path.toUpperCase()
  let clock = 1_000
  return {
    write(path, data, mtimeMs = clock++) {
      files.set(key(path), { data, mtimeMs })
    },
    remove(path) {
      files.delete(key(path))
    },
    head: (path, bytes) => files.get(key(path))?.data.subarray(0, bytes) ?? null,
    stat: (path) => {
      const file = files.get(key(path))
      return file ? { mtimeMs: file.mtimeMs, size: file.data.length } : null
    },
    readFile: async (path) => {
      const file = files.get(key(path))
      if (!file) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return file.data
    }
  }
}

interface Harness {
  service: WallpaperService
  api: FakeWin32Api
  fs: ReturnType<typeof memoryFs>
  emitted: WallpaperChanged[]
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
  displays: WallpaperDisplay[]
  watcher: { onChange: (() => void) | null; close: ReturnType<typeof vi.fn> }
}

function harness(): Harness {
  const api = createFakeWin32Api()
  const fs = memoryFs()
  const emitted: WallpaperChanged[] = []
  const log = { info: vi.fn(), warn: vi.fn() }
  const displays = [PRIMARY, SECONDARY]
  const watcher: Harness['watcher'] = { onChange: null, close: vi.fn(async () => {}) }
  fs.write('C:\\art\\wide.jpg', JPEG)
  api.setWallpaper(PRIMARY_PX, { path: 'C:\\art\\wide.jpg', position: 'fit', monitorIndex: 0 })
  api.setWallpaper(SECONDARY_PX, { path: 'C:\\art\\wide.jpg', position: 'fit', monitorIndex: 1 })
  api.setRegistryString('HKCU', 'Control Panel\\Colors', 'Background', '0 99 177')
  const service = createWallpaperService({
    api,
    displays: () => displays,
    themesDir: THEMES,
    fs,
    emit: (payload) => emitted.push(payload),
    log,
    watchThemes: async (dir, onChange) => {
      expect(dir).toBe(THEMES)
      watcher.onChange = onChange
      return { close: watcher.close }
    }
  })
  return { service, api, fs, emitted, log, displays, watcher }
}

describe('wallpaperUrl / parseWallpaperUrl', () => {
  it('round-trips taskyard://wallpaper/<displayId>?v=<n>', () => {
    expect(wallpaperUrl(2528732444, 3)).toBe('taskyard://wallpaper/2528732444?v=3')
    expect(parseWallpaperUrl('taskyard://wallpaper/2528732444?v=3')).toBe(2528732444)
    expect(parseWallpaperUrl('taskyard://wallpaper/12/')).toBe(12)
  })

  it('rejects any other host, path or scheme', () => {
    expect(parseWallpaperUrl('taskyard://icons/12')).toBeNull()
    expect(parseWallpaperUrl('taskyard://wallpaper/../../etc')).toBeNull()
    expect(parseWallpaperUrl('taskyard://wallpaper/-1')).toBeNull()
    expect(parseWallpaperUrl('file:///C:/art/wide.jpg')).toBeNull()
    expect(parseWallpaperUrl('not a url')).toBeNull()
  })
})

describe('WallpaperService.describe', () => {
  it("describes each display's wallpaper: url, position, colour and physical geometry", () => {
    const { service } = harness()
    expect(service.describe(12)).toEqual({
      displayId: 12,
      version: 1,
      url: 'taskyard://wallpaper/12?v=1',
      position: 'fit',
      color: '#0063b1',
      scaleFactor: 1,
      displayRectPx: SECONDARY_PX,
      virtualRectPx: { x: 0, y: 0, width: 4480, height: 1440 },
      hint: null
    })
    expect(service.describe(99)).toBeNull()
  })

  it('reports a solid-colour desktop (no url) with its hint, logging it once', () => {
    const { service, api, log } = harness()
    api.setWallpaper(PRIMARY_PX, { path: null, position: 'fill', monitorIndex: 0 })
    expect(service.describe(11)).toMatchObject({ url: null, hint: 'solid-color', color: '#0063b1' })
    service.describe(11)
    service.refresh()
    const lines = log.info.mock.calls.filter(([line]) => String(line).includes('display 11'))
    expect(lines).toHaveLength(1)
    expect(lines[0][0]).toMatch(/no picture.*#0063b1/)
  })

  it("serves Windows' transcoded copy for an undecodable .jxr, with one warning", () => {
    const { service, api, fs, log } = harness()
    fs.write('D:\\hdr\\sky.jxr', JXR)
    fs.write(`${THEMES}\\Transcoded_001`, JPEG)
    api.setWallpaper(SECONDARY_PX, { path: 'D:\\hdr\\sky.jxr', position: 'fill', monitorIndex: 1 })
    expect(service.describe(12)).toMatchObject({
      hint: 'transcoded',
      url: 'taskyard://wallpaper/12?v=1'
    })
    service.refresh()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toMatch(/sky\.jxr.*cannot be decoded.*Transcoded_001/)
  })

  it('falls back to the colour when Win32 cannot say (TASKYARD_NO_WIN32 fake)', () => {
    const fresh = createWallpaperService({
      api: createFakeWin32Api(),
      displays: () => [PRIMARY],
      themesDir: THEMES,
      fs: memoryFs(),
      emit: () => {},
      log: { info: vi.fn(), warn: vi.fn() }
    })
    expect(fresh.describe(11)).toMatchObject({ url: null, hint: 'unavailable', color: '#000000' })
  })

  it('uses Electron DIP → screen conversion when given (mixed DPI)', () => {
    const toScreenRect = vi.fn((bounds) => (bounds.x === 0 ? PRIMARY_PX : SECONDARY_PX))
    const api = createFakeWin32Api()
    api.setWallpaper(SECONDARY_PX, { path: null, position: 'fill', monitorIndex: 1 })
    const service = createWallpaperService({
      api,
      displays: () => [
        { id: 11, bounds: { x: 0, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 },
        { id: 12, bounds: { x: 1707, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
      ],
      toScreenRect,
      themesDir: THEMES,
      fs: memoryFs(),
      emit: () => {},
      log: { info: vi.fn(), warn: vi.fn() }
    })
    expect(service.describe(12)).toMatchObject({
      displayRectPx: SECONDARY_PX,
      virtualRectPx: { x: 0, y: 0, width: 4480, height: 1440 },
      hint: 'solid-color'
    })
  })
})

describe('WallpaperService.refresh', () => {
  it('bumps the version and emits wallpaper:changed only for the display whose wallpaper changed', () => {
    const { service, api, fs, emitted } = harness()
    service.describe(11)
    service.describe(12)

    service.refresh()
    expect(emitted).toEqual([])

    fs.write('C:\\art\\next.png', PNG)
    api.setWallpaper(SECONDARY_PX, { path: 'C:\\art\\next.png', position: 'fill', monitorIndex: 1 })
    service.refresh()
    expect(emitted).toEqual([{ displayId: 12, version: 2 }])
    expect(service.describe(12)?.url).toBe('taskyard://wallpaper/12?v=2')
    expect(service.describe(11)?.version).toBe(1)
  })

  it('notices the same path rewritten with new pixels (slideshow into one file, Spotlight)', () => {
    const { service, fs, emitted } = harness()
    service.describe(11)
    service.describe(12)
    fs.write('C:\\art\\wide.jpg', Buffer.concat([JPEG, Buffer.from([9])]))
    service.refresh()
    expect(emitted.map((e) => e.displayId).sort()).toEqual([11, 12])
  })

  it('notices a new transcoded copy while the source stays undecodable', () => {
    const { service, api, fs, emitted } = harness()
    fs.write('D:\\hdr\\sky.jxr', JXR)
    api.setWallpaper(PRIMARY_PX, { path: 'D:\\hdr\\sky.jxr', position: 'fill', monitorIndex: 0 })
    expect(service.describe(11)?.hint).toBe('color-fallback')
    fs.write(`${THEMES}\\Transcoded_000`, JPEG)
    service.refresh()
    expect(emitted).toContainEqual({ displayId: 11, version: 2 })
    expect(service.describe(11)?.hint).toBe('transcoded')
  })
})

describe('WallpaperService.handle (taskyard:// protocol)', () => {
  it("serves the display's current file with its sniffed content type", async () => {
    const { service } = harness()
    const response = await service.handle('taskyard://wallpaper/11?v=1')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(JPEG)
  })

  it('serves the transcoded copy for an undecodable source', async () => {
    const { service, api, fs } = harness()
    fs.write('D:\\hdr\\sky.jxr', JXR)
    fs.write(`${THEMES}\\Transcoded_001`, PNG)
    api.setWallpaper(SECONDARY_PX, { path: 'D:\\hdr\\sky.jxr', position: 'fill', monitorIndex: 1 })
    const response = await service.handle('taskyard://wallpaper/12?v=1')
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
  })

  it('answers 404 for unknown displays, colour-only desktops, bad URLs and vanished files', async () => {
    const { service, api, fs } = harness()
    expect((await service.handle('taskyard://wallpaper/99')).status).toBe(404)
    expect((await service.handle('taskyard://elsewhere/11')).status).toBe(404)
    api.setWallpaper(PRIMARY_PX, { path: null, position: 'fill', monitorIndex: 0 })
    service.refresh()
    expect((await service.handle('taskyard://wallpaper/11')).status).toBe(404)
    fs.remove('C:\\art\\wide.jpg')
    // describe() is what re-resolves; the file vanished between resolve and read.
    expect((await service.handle('taskyard://wallpaper/12')).status).toBe(404)
  })
})

describe('WallpaperService triggers', () => {
  let h: Harness
  beforeEach(() => {
    vi.useFakeTimers()
    h = harness()
    h.service.describe(11)
    h.service.describe(12)
  })
  afterEach(async () => {
    await h.service.stop()
    vi.useRealTimers()
  })

  const changeSecondary = (): void => {
    h.fs.write('C:\\art\\next.png', PNG)
    h.api.setWallpaper(SECONDARY_PX, {
      path: 'C:\\art\\next.png',
      position: 'fill',
      monitorIndex: 1
    })
  }

  it('WM_SETTINGCHANGE bursts (one per window) coalesce into one refresh well inside 2 s', async () => {
    await h.service.start()
    changeSecondary()
    h.service.settingChanged()
    h.service.settingChanged()
    expect(h.emitted).toEqual([])
    vi.advanceTimersByTime(SETTING_CHANGE_DEBOUNCE_MS)
    expect(h.emitted).toEqual([{ displayId: 12, version: 2 }])
    expect(SETTING_CHANGE_DEBOUNCE_MS).toBeLessThan(2_000)
  })

  it('a write in the Themes folder (slideshow / Spotlight transcode) refreshes', async () => {
    await h.service.start()
    changeSecondary()
    h.watcher.onChange?.()
    vi.advanceTimersByTime(SETTING_CHANGE_DEBOUNCE_MS)
    expect(h.emitted).toEqual([{ displayId: 12, version: 2 }])
  })

  it('the 60 s poll catches what no event announced', async () => {
    await h.service.start()
    changeSecondary()
    vi.advanceTimersByTime(WALLPAPER_POLL_MS - 1)
    expect(h.emitted).toEqual([])
    vi.advanceTimersByTime(1)
    expect(h.emitted).toEqual([{ displayId: 12, version: 2 }])
    expect(WALLPAPER_POLL_MS).toBe(60_000)
  })

  it('keeps working when the Themes folder cannot be watched (logged)', async () => {
    const service = createWallpaperService({
      api: h.api,
      displays: () => h.displays,
      themesDir: THEMES,
      fs: h.fs,
      emit: (payload) => h.emitted.push(payload),
      log: h.log,
      watchThemes: async () => {
        throw new Error('ENOENT')
      }
    })
    service.describe(12)
    await service.start()
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('cannot watch'),
      expect.any(Error)
    )
    changeSecondary()
    vi.advanceTimersByTime(WALLPAPER_POLL_MS)
    expect(h.emitted).toContainEqual({ displayId: 12, version: 2 })
    await service.stop()
  })

  it('stop() closes the watcher and cancels the poll and pending refreshes', async () => {
    await h.service.start()
    h.service.settingChanged()
    await h.service.stop()
    changeSecondary()
    vi.advanceTimersByTime(WALLPAPER_POLL_MS * 2)
    expect(h.emitted).toEqual([])
    expect(h.watcher.close).toHaveBeenCalledTimes(1)
  })

  it('a display that went away is forgotten; one that came back starts over', () => {
    h.displays.splice(1, 1)
    h.service.refresh()
    expect(h.service.describe(12)).toBeNull()
    h.displays.push(SECONDARY)
    expect(h.service.describe(12)?.version).toBe(1)
  })

  it('a Win32 failure during a refresh is logged, never thrown into a timer', async () => {
    await h.service.start()
    vi.spyOn(h.api, 'getWallpaperForMonitor').mockImplementation(() => {
      throw new Error('COM exploded')
    })
    expect(() => vi.advanceTimersByTime(WALLPAPER_POLL_MS)).not.toThrow()
    expect(h.log.warn).toHaveBeenCalledWith('wallpaper: refresh failed', expect.any(Error))
  })
})
