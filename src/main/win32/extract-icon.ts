import type { IconBitmap } from './api'
import type { Koffi } from './bindings'

// Phase 5 — icon extraction: user32 (PrivateExtractIconsW, GetIconInfo, DestroyIcon) and gdi32
// (GetObjectW, CreateCompatibleDC, GetDIBits, DeleteObject, DeleteDC). Kept apart from
// bindings.ts so its declarations and handle handling stay in one place.

export const BITMAPINFOHEADER_SIZE = 40
export const BI_RGB = 0
export const DIB_RGB_COLORS = 0
/** `sizeof(BITMAP)` on x64: LONG×4, WORD×2, 4 padding bytes, LPVOID. */
const BITMAP_SIZE = 32
/** PrivateExtractIconsW's "cannot open the file". */
const EXTRACT_FAILED = 0xffffffff
const BYTES_PER_PIXEL = 4

/** ICONINFO; the bitmaps are owned by the caller of GetIconInfo and must be deleted. */
export interface IconInfo {
  fIcon: number
  xHotspot: number
  yHotspot: number
  hbmMask: bigint | null
  hbmColor: bigint | null
}

/** The Win32 calls icon extraction makes. Handles are `void *` (BigInt, null for NULL). */
export interface IconBindings {
  PrivateExtractIconsW(
    file: string,
    index: number,
    cx: number,
    cy: number,
    icons: [bigint | null],
    ids: null,
    count: number,
    flags: number
  ): number
  GetIconInfo(icon: bigint, info: IconInfo): boolean
  DestroyIcon(icon: bigint): boolean
  GetObjectW(handle: bigint, size: number, out: Buffer): number
  CreateCompatibleDC(hdc: null): bigint | null
  DeleteDC(hdc: bigint): boolean
  GetDIBits(
    hdc: bigint,
    bitmap: bigint,
    start: number,
    lines: number,
    bits: Buffer | null,
    info: Buffer,
    usage: number
  ): number
  DeleteObject(handle: bigint): boolean
  /** kernel32; used by `Win32Api.getDriveType` (review fix). */
  GetDriveTypeW(root: string): number
}

const cache = new WeakMap<Koffi, IconBindings>()

/** Declares the icon calls (once per koffi instance). BOOL is a 32-bit int, as in bindings.ts. */
export function loadIconBindings(koffi: Koffi): IconBindings {
  const cached = cache.get(koffi)
  if (cached) return cached
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  // Anonymous struct: koffi's named types outlive a re-imported module (see bindings.ts).
  const ICONINFO = koffi.struct({
    fIcon: 'int',
    xHotspot: 'uint32_t',
    yHotspot: 'uint32_t',
    hbmMask: 'void *',
    hbmColor: 'void *'
  })
  const bool =
    <A extends unknown[]>(fn: (...args: A) => number) =>
    (...args: A): boolean =>
      fn(...args) !== 0

  const bindings: IconBindings = {
    PrivateExtractIconsW: user32.func('__stdcall', 'PrivateExtractIconsW', 'uint32_t', [
      'str16',
      'int',
      'int',
      'int',
      koffi.out(koffi.pointer('void *')),
      'void *',
      'uint32_t',
      'uint32_t'
    ]),
    GetIconInfo: bool(
      user32.func('__stdcall', 'GetIconInfo', 'int', ['void *', koffi.out(koffi.pointer(ICONINFO))])
    ),
    DestroyIcon: bool(user32.func('int __stdcall DestroyIcon(void *icon)')),
    GetObjectW: gdi32.func('int __stdcall GetObjectW(void *handle, int size, void *out)'),
    CreateCompatibleDC: gdi32.func('void * __stdcall CreateCompatibleDC(void *hdc)'),
    DeleteDC: bool(gdi32.func('int __stdcall DeleteDC(void *hdc)')),
    GetDIBits: gdi32.func(
      'int __stdcall GetDIBits(void *hdc, void *bitmap, uint32_t start, uint32_t lines, void *bits, void *info, uint32_t usage)'
    ),
    DeleteObject: bool(gdi32.func('int __stdcall DeleteObject(void *handle)')),
    GetDriveTypeW: kernel32.func('uint32_t __stdcall GetDriveTypeW(str16 root)')
  }
  cache.set(koffi, bindings)
  return bindings
}

function bitmapSize(b: IconBindings, bitmap: bigint): { width: number; height: number } {
  const out = Buffer.alloc(BITMAP_SIZE)
  if (b.GetObjectW(bitmap, BITMAP_SIZE, out) === 0) throw new Error('GetObjectW failed')
  return { width: out.readInt32LE(4), height: Math.abs(out.readInt32LE(8)) }
}

/** The bitmap's rows as 32-bpp, top-down BGRA (a negative biHeight asks for top-down). */
function readBits(
  b: IconBindings,
  hdc: bigint,
  bitmap: bigint,
  width: number,
  height: number
): Buffer {
  // Room for a colour table too: GetDIBits may write one for a monochrome source.
  const info = Buffer.alloc(BITMAPINFOHEADER_SIZE + 256 * 4)
  info.writeUInt32LE(BITMAPINFOHEADER_SIZE, 0)
  info.writeInt32LE(width, 4)
  info.writeInt32LE(-height, 8)
  info.writeUInt16LE(1, 12)
  info.writeUInt16LE(32, 14)
  info.writeUInt32LE(BI_RGB, 16)
  const bits = Buffer.alloc(width * height * BYTES_PER_PIXEL)
  const lines = b.GetDIBits(hdc, bitmap, 0, height, bits, info, DIB_RGB_COLORS)
  if (lines !== height) throw new Error(`GetDIBits read ${lines} of ${height} rows`)
  return bits
}

function readIcon(b: IconBindings, info: IconInfo, px: number): IconBitmap {
  const hdc = b.CreateCompatibleDC(null)
  if (hdc === null) throw new Error('CreateCompatibleDC failed')
  try {
    if (info.hbmColor !== null) {
      const { width, height } = bitmapSize(b, info.hbmColor)
      if (width !== px || height !== px) {
        throw new Error(`the icon is ${width}x${height}, expected ${px}x${px}`)
      }
      const bgra = readBits(b, hdc, info.hbmColor, width, height)
      const mask = info.hbmMask === null ? null : readBits(b, hdc, info.hbmMask, width, height)
      return { width, height, bgra, mask }
    }
    if (info.hbmMask === null) throw new Error('GetIconInfo returned no bitmaps')
    // A monochrome icon: one mask twice as tall, the AND mask on top of the XOR image.
    const { width, height: doubled } = bitmapSize(b, info.hbmMask)
    const height = doubled / 2
    if (width !== px || height !== px) {
      throw new Error(`the icon is ${width}x${height}, expected ${px}x${px}`)
    }
    const both = readBits(b, hdc, info.hbmMask, width, doubled)
    const half = width * height * BYTES_PER_PIXEL
    const bgra = Buffer.from(both.subarray(half))
    for (let i = 3; i < bgra.length; i += BYTES_PER_PIXEL) bgra[i] = 0
    return { width, height, bgra, mask: Buffer.from(both.subarray(0, half)) }
  } finally {
    b.DeleteDC(hdc)
  }
}

/**
 * Icon `index` of `file` (≥ 0: the n-th icon; < 0: resource id) scaled to `px`×`px`, as raw
 * 32-bpp BGRA plus its AND mask. Null when the file has no such icon; throws when Windows cannot
 * read the file or a GDI call fails. Every handle it gets (HICON, both bitmaps, the DC) is freed
 * on every path.
 */
export function extractIconWith(
  b: IconBindings,
  file: string,
  index: number,
  px: number
): IconBitmap | null {
  const icons: [bigint | null] = [null]
  const count = b.PrivateExtractIconsW(file, index, px, px, icons, null, 1, 0)
  if (count === EXTRACT_FAILED) throw new Error(`PrivateExtractIconsW cannot read ${file}`)
  const icon = icons[0]
  if (count === 0 || icon === null || icon === 0n) return null
  try {
    const info: IconInfo = { fIcon: 0, xHotspot: 0, yHotspot: 0, hbmMask: null, hbmColor: null }
    if (!b.GetIconInfo(icon, info)) throw new Error('GetIconInfo failed')
    // koffi may hand NULL back as 0n.
    if (info.hbmColor === 0n) info.hbmColor = null
    if (info.hbmMask === 0n) info.hbmMask = null
    try {
      return readIcon(b, info, px)
    } finally {
      if (info.hbmColor !== null) b.DeleteObject(info.hbmColor)
      if (info.hbmMask !== null) b.DeleteObject(info.hbmMask)
    }
  } finally {
    b.DestroyIcon(icon)
  }
}
