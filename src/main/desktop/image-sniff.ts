/** How many leading bytes `sniffImage` needs (the WebP signature ends at byte 12). */
export const IMAGE_SNIFF_BYTES = 16

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/bmp' | 'image/gif' | 'image/webp'

const startsWith = (
  head: Buffer,
  offset: number,
  signature: readonly number[] | string
): boolean => {
  const bytes = typeof signature === 'string' ? Buffer.from(signature, 'latin1') : signature
  if (head.length < offset + bytes.length) return false
  for (let i = 0; i < bytes.length; i++) if (head[offset + i] !== bytes[i]) return false
  return true
}

/**
 * The content type of an image Chromium can decode, from its first bytes (never the file name:
 * Windows' own wallpaper caches have no extension, and a renamed file keeps its format).
 * Null for anything else — JPEG XR (`.jxr`, HDR wallpapers), HEIC, TIFF — which the wallpaper
 * layer cannot show.
 */
export function sniffImage(head: Buffer): ImageMime | null {
  if (startsWith(head, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(head, 0, 'GIF87a') || startsWith(head, 0, 'GIF89a')) return 'image/gif'
  if (startsWith(head, 0, 'RIFF') && startsWith(head, 8, 'WEBP')) return 'image/webp'
  // BITMAPFILEHEADER: "BM" then the file size; require the size field so "BM…" text is not a BMP.
  if (startsWith(head, 0, 'BM') && head.length >= 6) return 'image/bmp'
  return null
}
