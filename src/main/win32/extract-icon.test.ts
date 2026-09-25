import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Koffi, Win32Bindings } from './bindings'
import { createKoffiWin32Api } from './koffi-api'
import {
  BITMAPINFOHEADER_SIZE,
  BI_RGB,
  DIB_RGB_COLORS,
  extractIconWith,
  type IconBindings,
  type IconInfo
} from './extract-icon'

/**
 * Headless: the user32/gdi32 icon calls are fakes over a tiny handle table, so this suite never
 * loads a DLL. The real calls run in koffi-api.win32.test.ts (npm run test:win32).
 */

const HICON = 0x11n
const COLOR = 0x21n
const MASK = 0x22n
const HDC = 0x31n

interface FakeIconBindings {
  b: { [K in keyof IconBindings]: Mock<IconBindings[K]> }
  /** Bitmap handle → its size and one fill byte per pixel channel. */
  bitmaps: Map<bigint, { width: number; height: number; fill: number }>
  headers: Buffer[]
}

function fakeIconBindings(): FakeIconBindings {
  const bitmaps = new Map<bigint, { width: number; height: number; fill: number }>([
    [COLOR, { width: 4, height: 4, fill: 0x7f }],
    [MASK, { width: 4, height: 4, fill: 0x00 }]
  ])
  const headers: Buffer[] = []
  const b = {
    PrivateExtractIconsW: vi.fn<IconBindings['PrivateExtractIconsW']>(
      (_file, _index, _cx, _cy, icons) => {
        icons[0] = HICON
        return 1
      }
    ),
    GetIconInfo: vi.fn<IconBindings['GetIconInfo']>((_icon, info: IconInfo) => {
      info.fIcon = 1
      info.hbmColor = COLOR
      info.hbmMask = MASK
      return true
    }),
    DestroyIcon: vi.fn<IconBindings['DestroyIcon']>(() => true),
    GetObjectW: vi.fn<IconBindings['GetObjectW']>((handle, size, out) => {
      const bitmap = bitmaps.get(handle)
      if (bitmap === undefined) return 0
      out.writeInt32LE(bitmap.width, 4)
      out.writeInt32LE(bitmap.height, 8)
      return size
    }),
    CreateCompatibleDC: vi.fn<IconBindings['CreateCompatibleDC']>(() => HDC),
    DeleteDC: vi.fn<IconBindings['DeleteDC']>(() => true),
    GetDIBits: vi.fn<IconBindings['GetDIBits']>((_hdc, handle, _start, lines, bits, info) => {
      headers.push(Buffer.from(info.subarray(0, BITMAPINFOHEADER_SIZE)))
      const bitmap = bitmaps.get(handle)
      if (bitmap === undefined || bits === null) return 0
      // A mono mask (double height, no colour bitmap): AND rows white, XOR rows grey.
      for (let row = 0; row < lines; row++) {
        const value = bitmap.height > bitmap.width && row < bitmap.width ? 0xff : bitmap.fill
        bits.fill(value, row * bitmap.width * 4, (row + 1) * bitmap.width * 4)
      }
      return lines
    }),
    DeleteObject: vi.fn<IconBindings['DeleteObject']>(() => true),
    GetDriveTypeW: vi.fn<IconBindings['GetDriveTypeW']>(() => 3)
  }
  return { b, bitmaps, headers }
}

let fake: FakeIconBindings

beforeEach(() => {
  fake = fakeIconBindings()
})

const extract = (
  file = 'C:\\Windows\\notepad.exe',
  index = 0,
  px = 4
): ReturnType<typeof extractIconWith> => extractIconWith(fake.b, file, index, px)

function expectEverythingFreed(): void {
  expect(fake.b.DestroyIcon).toHaveBeenCalledWith(HICON)
  expect(fake.b.DeleteObject).toHaveBeenCalledWith(COLOR)
  expect(fake.b.DeleteObject).toHaveBeenCalledWith(MASK)
  expect(fake.b.DeleteDC).toHaveBeenCalledWith(HDC)
}

describe('extractIconWith', () => {
  it('asks PrivateExtractIconsW for one icon at px × px', () => {
    extract('C:\\Windows\\System32\\imageres.dll', -3, 4)

    expect(fake.b.PrivateExtractIconsW).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\imageres.dll',
      -3,
      4,
      4,
      [HICON],
      null,
      1,
      0
    )
  })

  it('reads the colour and mask bitmaps as 32-bpp top-down BGRA and frees every handle', () => {
    const icon = extract()

    expect(icon).toEqual({
      width: 4,
      height: 4,
      bgra: Buffer.alloc(64, 0x7f),
      mask: Buffer.alloc(64, 0x00)
    })
    expect(fake.b.GetDIBits).toHaveBeenCalledTimes(2)
    for (const header of fake.headers) {
      expect(header.readUInt32LE(0)).toBe(BITMAPINFOHEADER_SIZE)
      expect(header.readInt32LE(4)).toBe(4)
      expect(header.readInt32LE(8)).toBe(-4) // negative height: top-down rows
      expect(header.readUInt16LE(12)).toBe(1)
      expect(header.readUInt16LE(14)).toBe(32)
      expect(header.readUInt32LE(16)).toBe(BI_RGB)
    }
    expect(fake.b.GetDIBits.mock.calls[0][6]).toBe(DIB_RGB_COLORS)
    expectEverythingFreed()
  })

  it('splits a monochrome icon (mask only, double height) into its AND and XOR halves', () => {
    fake.b.GetIconInfo.mockImplementation((_icon, info) => {
      info.hbmColor = null
      info.hbmMask = MASK
      return true
    })
    fake.bitmaps.set(MASK, { width: 4, height: 8, fill: 0x80 })

    const icon = extract()

    // The XOR image has no alpha channel: alpha 0 everywhere, so it comes from the AND mask.
    const xor = Buffer.alloc(64, 0x80)
    for (let i = 3; i < xor.length; i += 4) xor[i] = 0
    expect(icon).toEqual({ width: 4, height: 4, bgra: xor, mask: Buffer.alloc(64, 0xff) })
    expect(fake.b.DestroyIcon).toHaveBeenCalledWith(HICON)
    expect(fake.b.DeleteObject).toHaveBeenCalledWith(MASK)
    expect(fake.b.DeleteObject).toHaveBeenCalledTimes(1)
  })

  it('returns null when the file has no icon at that index', () => {
    fake.b.PrivateExtractIconsW.mockReturnValue(0)

    expect(extract()).toBeNull()
    expect(fake.b.GetIconInfo).not.toHaveBeenCalled()
    expect(fake.b.DestroyIcon).not.toHaveBeenCalled()
  })

  it('throws for a file Windows cannot open', () => {
    fake.b.PrivateExtractIconsW.mockReturnValue(0xffffffff)

    expect(() => extract('C:\\missing.exe')).toThrow(
      'PrivateExtractIconsW cannot read C:\\missing.exe'
    )
  })

  it('frees every handle even when reading the pixels fails', () => {
    fake.b.GetDIBits.mockReturnValue(0)

    expect(() => extract()).toThrow('GetDIBits read 0 of 4 rows')
    expectEverythingFreed()
  })

  it('destroys the icon even when GetIconInfo fails', () => {
    fake.b.GetIconInfo.mockReturnValue(false)

    expect(() => extract()).toThrow('GetIconInfo failed')
    expect(fake.b.DestroyIcon).toHaveBeenCalledWith(HICON)
    expect(fake.b.CreateCompatibleDC).not.toHaveBeenCalled()
  })

  it('frees the bitmaps when no device context can be created', () => {
    fake.b.CreateCompatibleDC.mockReturnValue(null)

    expect(() => extract()).toThrow('CreateCompatibleDC failed')
    expect(fake.b.DestroyIcon).toHaveBeenCalledWith(HICON)
    expect(fake.b.DeleteObject).toHaveBeenCalledWith(COLOR)
    expect(fake.b.DeleteObject).toHaveBeenCalledWith(MASK)
  })

  it('refuses a bitmap of another size than asked for', () => {
    fake.bitmaps.set(COLOR, { width: 8, height: 8, fill: 1 })

    expect(() => extract()).toThrow('the icon is 8x8, expected 4x4')
    expectEverythingFreed()
  })
})

describe('createKoffiWin32Api().getDriveType (Phase 5 review fix)', () => {
  it('asks GetDriveTypeW about the drive root', () => {
    const GetDriveTypeW = vi.fn(() => 4)
    const api = createKoffiWin32Api({} as Koffi, {
      log: { warn: vi.fn(), error: vi.fn() },
      bindings: {} as Win32Bindings,
      iconBindings: { ...fake.b, GetDriveTypeW }
    })

    expect(api.getDriveType('Z:\\')).toBe(4)
    expect(GetDriveTypeW).toHaveBeenCalledWith('Z:\\')
  })
})

describe('createKoffiWin32Api().extractIcon', () => {
  it('extracts through the icon bindings', () => {
    const api = createKoffiWin32Api({} as Koffi, {
      log: { warn: vi.fn(), error: vi.fn() },
      bindings: {} as Win32Bindings,
      iconBindings: fake.b
    })

    expect(api.extractIcon('C:\\Windows\\notepad.exe', 0, 4)?.width).toBe(4)
    expect(fake.b.PrivateExtractIconsW).toHaveBeenCalledOnce()
  })
})
