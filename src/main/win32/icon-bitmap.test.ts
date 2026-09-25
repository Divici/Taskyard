import { describe, expect, it, vi } from 'vitest'
import type { IconBitmap } from './api'
import { iconBitmapToPng, premultiplyIcon, type NativeImageFactory } from './icon-bitmap'

/** One BGRA pixel per entry. */
const pixels = (...values: Array<[number, number, number, number]>): Buffer =>
  Buffer.from(values.flat())

const read = (data: Buffer, index: number): number[] => [...data.subarray(index * 4, index * 4 + 4)]

/** A stand-in for Electron's nativeImage: remembers what it was built from. */
function fakeNativeImage(): NativeImageFactory & {
  created: Array<{ buffer: Buffer; width: number; height: number }>
} {
  const created: Array<{ buffer: Buffer; width: number; height: number }> = []
  return {
    created,
    createFromBitmap(buffer, { width, height }) {
      if (buffer.length !== width * height * 4) throw new Error('Bitmap size does not match')
      created.push({ buffer: Buffer.from(buffer), width, height })
      return {
        getSize: () => ({ width, height }),
        isEmpty: () => width === 0 || height === 0,
        toPNG: () => Buffer.from(`png ${width}x${height}`)
      }
    }
  }
}

describe('premultiplyIcon', () => {
  it('premultiplies a known pixel: each colour channel × alpha / 255, rounded', () => {
    const icon: IconBitmap = {
      width: 2,
      height: 1,
      bgra: pixels([200, 100, 50, 128], [10, 20, 30, 255]),
      mask: null
    }

    const { data } = premultiplyIcon(icon)

    expect(read(data, 0)).toEqual([100, 50, 25, 128])
    expect(read(data, 1)).toEqual([10, 20, 30, 255])
  })

  it('makes a fully transparent pixel all zero, whatever colour it carried', () => {
    const icon: IconBitmap = {
      width: 2,
      height: 1,
      bgra: pixels([255, 255, 255, 0], [1, 2, 3, 255]),
      mask: null
    }

    expect(read(premultiplyIcon(icon).data, 0)).toEqual([0, 0, 0, 0])
  })

  it('never changes the icon it was given', () => {
    const bgra = pixels([200, 100, 50, 128])
    premultiplyIcon({ width: 1, height: 1, bgra, mask: null })
    expect(read(bgra, 0)).toEqual([200, 100, 50, 128])
  })

  it('gives a legacy icon with an all-zero alpha channel its alpha from the AND mask', () => {
    // GetDIBits renders the monochrome mask as white (1 = transparent) and black (0 = opaque).
    const icon: IconBitmap = {
      width: 3,
      height: 1,
      bgra: pixels([10, 20, 30, 0], [40, 50, 60, 0], [70, 80, 90, 0]),
      mask: pixels([0, 0, 0, 0], [255, 255, 255, 0], [0, 0, 0, 0])
    }

    const { data } = premultiplyIcon(icon)

    expect(read(data, 0)).toEqual([10, 20, 30, 255])
    expect(read(data, 1)).toEqual([0, 0, 0, 0])
    expect(read(data, 2)).toEqual([70, 80, 90, 255])
  })

  it('treats an all-zero alpha icon without a mask as fully opaque', () => {
    const icon: IconBitmap = {
      width: 1,
      height: 1,
      bgra: pixels([10, 20, 30, 0]),
      mask: null
    }

    expect(read(premultiplyIcon(icon).data, 0)).toEqual([10, 20, 30, 255])
  })

  it('ignores the mask when the icon has its own alpha channel', () => {
    const icon: IconBitmap = {
      width: 2,
      height: 1,
      bgra: pixels([10, 20, 30, 255], [40, 50, 60, 0]),
      mask: pixels([255, 255, 255, 0], [0, 0, 0, 0])
    }

    const { data } = premultiplyIcon(icon)

    expect(read(data, 0)).toEqual([10, 20, 30, 255])
    expect(read(data, 1)).toEqual([0, 0, 0, 0])
  })

  it('refuses pixel or mask buffers that do not match the size', () => {
    expect(() =>
      premultiplyIcon({ width: 2, height: 2, bgra: Buffer.alloc(12), mask: null })
    ).toThrow('icon: 2x2 needs 16 bytes of BGRA, got 12')
    expect(() =>
      premultiplyIcon({ width: 1, height: 1, bgra: Buffer.alloc(4), mask: Buffer.alloc(8) })
    ).toThrow('icon: 1x1 needs 4 bytes of mask, got 8')
    expect(() =>
      premultiplyIcon({ width: 0, height: 1, bgra: Buffer.alloc(0), mask: null })
    ).toThrow('icon: empty (0x1)')
  })
})

describe('iconBitmapToPng', () => {
  it('round-trips the size: the image is built at the icon size from premultiplied pixels', () => {
    const nativeImage = fakeNativeImage()
    const icon: IconBitmap = {
      width: 3,
      height: 2,
      bgra: Buffer.alloc(3 * 2 * 4, 0x80),
      mask: null
    }

    const png = iconBitmapToPng(icon, nativeImage)

    expect(png.toString()).toBe('png 3x2')
    expect(nativeImage.created).toHaveLength(1)
    const [{ buffer, width, height }] = nativeImage.created
    expect({ width, height }).toEqual({ width: 3, height: 2 })
    // 0x80 × 0x80 / 255 = 64.25 → 64
    expect(read(buffer, 0)).toEqual([64, 64, 64, 128])
  })

  it('throws when the image comes back with another size or empty', () => {
    const shrunk: NativeImageFactory = {
      createFromBitmap: vi.fn(() => ({
        getSize: () => ({ width: 1, height: 1 }),
        isEmpty: () => false,
        toPNG: () => Buffer.alloc(0)
      }))
    }
    const icon: IconBitmap = { width: 2, height: 2, bgra: Buffer.alloc(16, 255), mask: null }

    expect(() => iconBitmapToPng(icon, shrunk)).toThrow('icon: the image is 1x1, expected 2x2')
  })
})
