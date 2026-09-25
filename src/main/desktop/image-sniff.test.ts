import { describe, expect, it } from 'vitest'
import { IMAGE_SNIFF_BYTES, sniffImage } from './image-sniff'

const bytes = (...values: (number | string)[]): Buffer =>
  Buffer.concat(
    values.map((value) =>
      typeof value === 'string' ? Buffer.from(value, 'latin1') : Buffer.from([value])
    )
  )

describe('sniffImage', () => {
  it('recognises the formats Chromium decodes, by their magic bytes', () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe1, 0, 0))).toBe('image/jpeg')
    expect(sniffImage(bytes(0x89, 'PNG\r\n', 0x1a, '\n', 0, 0, 0, 13))).toBe('image/png')
    expect(sniffImage(bytes('BM', 0x36, 0x10, 0x0e, 0))).toBe('image/bmp')
    expect(sniffImage(bytes('GIF89a', 1, 0))).toBe('image/gif')
    expect(sniffImage(bytes('GIF87a', 1, 0))).toBe('image/gif')
    expect(sniffImage(bytes('RIFF', 0x24, 0, 0, 0, 'WEBPVP8 '))).toBe('image/webp')
  })

  it('rejects what Chromium cannot decode: JPEG XR (HDR .jxr), HEIC, TIFF, garbage', () => {
    expect(sniffImage(bytes(0x49, 0x49, 0xbc, 0x01, 8, 0, 0, 0))).toBeNull() // JPEG XR
    expect(sniffImage(bytes(0, 0, 0, 0x18, 'ftypheic'))).toBeNull()
    expect(sniffImage(bytes('II*', 0, 8, 0, 0, 0))).toBeNull() // TIFF
    expect(sniffImage(bytes('RIFF', 0x24, 0, 0, 0, 'WAVEfmt '))).toBeNull() // RIFF, not WebP
    expect(sniffImage(Buffer.from('<html>'))).toBeNull()
  })

  it('needs enough bytes; a truncated header is not an image', () => {
    expect(sniffImage(Buffer.alloc(0))).toBeNull()
    expect(sniffImage(bytes(0xff, 0xd8))).toBeNull()
    expect(sniffImage(bytes('RIFF', 0, 0, 0, 0, 'WEB'))).toBeNull()
    expect(IMAGE_SNIFF_BYTES).toBeGreaterThanOrEqual(12)
  })
})
