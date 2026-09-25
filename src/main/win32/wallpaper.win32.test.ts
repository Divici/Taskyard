import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Win32Api } from './api'
import type { Koffi } from './bindings'
import { createComRuntime, loadOle32 } from './com'
import { createKoffiWin32Api } from './koffi-api'
import {
  createDesktopWallpaperReader,
  desktopWallpaperProtos,
  positionFromRegistry,
  type DesktopWallpaperReader
} from './wallpaper'
import { realWin32TestsEnabled } from '../test/win32-opt-in'

// Opt-in: npm run test:win32. Read only: never sets a wallpaper, position or colour.
describe.runIf(realWin32TestsEnabled())('IDesktopWallpaper (real COM)', () => {
  let koffi: Koffi
  let reader: DesktopWallpaperReader
  let api: Win32Api
  const log = { warn: vi.fn(), error: vi.fn() }

  beforeAll(async () => {
    koffi = (await import('koffi')).default
    reader = createDesktopWallpaperReader(
      createComRuntime(koffi, loadOle32(koffi)),
      desktopWallpaperProtos(koffi)
    )
    api = createKoffiWin32Api(koffi, { log })
  })

  it('lists the attached monitors with physical RECTs, one at the virtual-screen origin', () => {
    const { monitors } = reader.read()
    const attached = monitors.filter((monitor) => monitor.rect !== null)
    expect(attached.length).toBeGreaterThan(0)
    for (const { rect, id } of attached) {
      // A device interface path: \\?\DISPLAY#<hardware id>#…
      expect(id.startsWith(String.raw`\\?\DISPLAY#`)).toBe(true)
      expect(rect!.width).toBeGreaterThan(0)
      expect(rect!.height).toBeGreaterThan(0)
    }
    // The primary monitor sits at (0, 0).
    expect(attached.some(({ rect }) => rect!.x === 0 && rect!.y === 0)).toBe(true)
  })

  it('agrees with the registry on the position (WallpaperStyle / TileWallpaper)', () => {
    const { position } = reader.read()
    const style = api.regGetString('HKCU', 'Control Panel\\Desktop', 'WallpaperStyle')
    const tile = api.regGetString('HKCU', 'Control Panel\\Desktop', 'TileWallpaper')
    expect(position).toBe(positionFromRegistry(style, tile))
  })

  it("answers getWallpaperForMonitor with each attached monitor's own wallpaper and index", () => {
    const { monitors, position } = reader.read()
    for (const monitor of monitors) {
      if (monitor.rect === null) continue
      expect(api.getWallpaperForMonitor(monitor.rect)).toEqual({
        path: monitor.path,
        position,
        monitorIndex: monitor.index
      })
    }
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('reads the same answer again and again from one instance', () => {
    const first = reader.read()
    for (let i = 0; i < 20; i++) expect(reader.read()).toEqual(first)
    reader.dispose()
    expect(reader.read()).toEqual(first)
  })
})
