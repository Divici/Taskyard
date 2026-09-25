import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Koffi } from './bindings'
import { createComRuntime, loadOle32, parseGuid, type ComRuntime } from './com'
import { CLSID_DESKTOP_WALLPAPER, IID_IDESKTOP_WALLPAPER } from './wallpaper'
import { realWin32TestsEnabled } from '../test/win32-opt-in'

// Opt-in: npm run test:win32. Read only: creates and releases COM objects, changes nothing.
describe.runIf(realWin32TestsEnabled())('COM over koffi (real ole32)', () => {
  let koffi: Koffi
  let com: ComRuntime
  let clsidFromString: (text: string, out: Buffer) => number

  beforeAll(async () => {
    koffi = (await import('koffi')).default
    com = createComRuntime(koffi, loadOle32(koffi))
    clsidFromString = koffi
      .load('ole32.dll')
      .func('long __stdcall CLSIDFromString(str16 text, _Out_ uint8_t *guid)') as never
  })

  afterAll(() => undefined)

  it('lays GUIDs out exactly as CLSIDFromString does', () => {
    for (const text of [CLSID_DESKTOP_WALLPAPER, IID_IDESKTOP_WALLPAPER]) {
      const expected = Buffer.alloc(16)
      expect(clsidFromString(text, expected)).toBe(0)
      expect(parseGuid(text).equals(expected)).toBe(true)
    }
  })

  it('creates IDesktopWallpaper, calls a method by vtable index and releases it', () => {
    const self = com.createInstance(CLSID_DESKTOP_WALLPAPER, IID_IDESKTOP_WALLPAPER)
    expect(self).not.toBe(0n)
    const countProto = koffi.proto('__stdcall', null, 'long', [
      'void *',
      koffi.out(koffi.pointer('uint32_t'))
    ])
    const count: [number] = [0]
    // Slot 6: GetMonitorDevicePathCount.
    expect(com.call(self, 6, countProto, count)).toBe(0)
    expect(count[0]).toBeGreaterThan(0)
    com.release(self)
  })

  it('survives many create/release cycles (no leak, no crash)', () => {
    for (let i = 0; i < 50; i++) {
      com.release(com.createInstance(CLSID_DESKTOP_WALLPAPER, IID_IDESKTOP_WALLPAPER))
    }
  })
})
