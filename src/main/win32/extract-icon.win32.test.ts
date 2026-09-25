import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Win32Api } from './api'
import type { Koffi } from './bindings'
import { premultiplyIcon } from './icon-bitmap'
import { DRIVE_FIXED, DRIVE_NO_ROOT_DIR } from './constants'
import { createKoffiWin32Api } from './koffi-api'
import { realWin32TestsEnabled } from '../test/win32-opt-in'

const GR_GDIOBJECTS = 0
const GR_USEROBJECTS = 1
const SYSTEM32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')

/** Pixel (x, y) of the test icon, top-down: B = 16x, G = 16y, R = 0x40, left half opaque. */
const pixelAt = (x: number, y: number): number[] => [x * 16, y * 16, 0x40, x < 8 ? 255 : 128]

/** A 16×16 32-bpp .ico whose pixels are `pixelAt` (DIB rows are stored bottom-up). */
function testIco(): Buffer {
  const size = 16
  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      Buffer.from(pixelAt(x, y)).copy(xor, ((size - 1 - y) * size + x) * 4)
    }
  }
  const and = Buffer.alloc(size * 4) // 16 bits per row, padded to 32: all opaque
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR + AND
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  const image = Buffer.concat([header, xor, and])
  const dir = Buffer.alloc(6 + 16)
  dir.writeUInt16LE(1, 2) // type: icon
  dir.writeUInt16LE(1, 4) // one image
  dir.writeUInt8(size, 6)
  dir.writeUInt8(size, 7)
  dir.writeUInt16LE(1, 10) // planes
  dir.writeUInt16LE(32, 12) // bits per pixel
  dir.writeUInt32LE(image.length, 14)
  dir.writeUInt32LE(dir.length, 18)
  return Buffer.concat([dir, image])
}

// Opt-in: npm run test:win32 (never part of npm test, never under TASKYARD_NO_WIN32=1).
describe.runIf(realWin32TestsEnabled())('extractIcon (real Win32)', () => {
  let api: Win32Api
  let handleCounts: () => { gdi: number; user: number }
  let tmp: string

  beforeAll(async () => {
    const koffi: Koffi = (await import('koffi')).default
    api = createKoffiWin32Api(koffi, { log: { warn: vi.fn(), error: vi.fn() } })
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    const getGuiResources = user32.func(
      'uint32_t __stdcall GetGuiResources(void *process, uint32_t flags)'
    )
    const currentProcess = kernel32.func('void * __stdcall GetCurrentProcess()')
    handleCounts = () => ({
      gdi: getGuiResources(currentProcess(), GR_GDIOBJECTS),
      user: getGuiResources(currentProcess(), GR_USEROBJECTS)
    })
    tmp = mkdtempSync(join(tmpdir(), 'taskyard-extract-icon-'))
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('extracts an .exe icon at 96 px with a real alpha channel', () => {
    const icon = api.extractIcon(join(SYSTEM32, 'notepad.exe'), 0, 96)

    expect(icon).not.toBeNull()
    expect(icon!.width).toBe(96)
    expect(icon!.height).toBe(96)
    expect(icon!.bgra).toHaveLength(96 * 96 * 4)
    const alphas = new Set<number>()
    for (let i = 3; i < icon!.bgra.length; i += 4) alphas.add(icon!.bgra[i])
    expect(alphas.has(0)).toBe(true) // transparent corners
    // An (almost) opaque body: Windows' downscale from 256 px leaves 254s.
    expect(Math.max(...alphas)).toBeGreaterThanOrEqual(250)
  })

  it('extracts the Windows folder icon (imageres.dll, resource id 3) at 64 px', () => {
    const icon = api.extractIcon(join(SYSTEM32, 'imageres.dll'), -3, 64)

    expect(icon).toMatchObject({ width: 64, height: 64 })
    const { data } = premultiplyIcon(icon!)
    expect(data.some((byte) => byte !== 0)).toBe(true)
  })

  it('reads an .ico file pixel for pixel: top-down rows, straight BGRA', () => {
    const file = join(tmp, 'test.ico')
    writeFileSync(file, testIco())

    const icon = api.extractIcon(file, 0, 16)!

    expect(icon).toMatchObject({ width: 16, height: 16 })
    for (const [x, y] of [
      [0, 0],
      [15, 0],
      [3, 9],
      [8, 15],
      [15, 15]
    ]) {
      const at = (y * 16 + x) * 4
      expect([...icon.bgra.subarray(at, at + 4)], `pixel ${x},${y}`).toEqual(pixelAt(x, y))
    }
  })

  it('returns null for an index past the last icon and throws for a missing file', () => {
    expect(api.extractIcon(join(SYSTEM32, 'notepad.exe'), 9999, 64)).toBeNull()
    expect(() => api.extractIcon(join(tmp, 'missing.exe'), 0, 64)).toThrow(
      /PrivateExtractIconsW cannot read/
    )
  })

  it('frees every GDI and USER handle it creates', () => {
    const file = join(SYSTEM32, 'imageres.dll')
    api.extractIcon(file, -3, 96) // warm-up: first-use allocations are not leaks
    const before = handleCounts()

    for (let i = 0; i < 50; i++) api.extractIcon(file, -3, 96)

    expect(handleCounts()).toEqual(before)
  })
})

// Opt-in: npm run test:win32.
describe.runIf(realWin32TestsEnabled())('getDriveType (real Win32, Phase 5 review fix)', () => {
  it('reports the system drive as fixed and a drive letter that is not mapped as no root', async () => {
    const koffi: Koffi = (await import('koffi')).default
    const api = createKoffiWin32Api(koffi, { log: { warn: vi.fn(), error: vi.fn() } })
    const systemDrive = `${(process.env['SystemDrive'] ?? 'C:').toUpperCase()}\\`
    const used = new Set(
      ['A', 'B', ...'CDEFGHIJKLMNOPQRSTUVWXYZ'].filter((l) => api.getDriveType(`${l}:\\`) !== 1)
    )
    const unused = [...'ZYXWVUTSRQPONMLKJIHGFED'].find((l) => !used.has(l))

    expect(api.getDriveType(systemDrive)).toBe(DRIVE_FIXED)
    expect(unused).toBeDefined()
    expect(api.getDriveType(`${unused}:\\`)).toBe(DRIVE_NO_ROOT_DIR)
  })
})
