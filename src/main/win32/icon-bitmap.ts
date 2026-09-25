import type { IconBitmap } from './api'

/** The part of Electron's `NativeImage` the icon pipeline uses. */
export interface NativeImageLike {
  getSize(): { width: number; height: number }
  isEmpty(): boolean
  toPNG(): Buffer
}

/** Electron's `nativeImage` module, injected so this file never imports electron. */
export interface NativeImageFactory {
  createFromBitmap(buffer: Buffer, options: { width: number; height: number }): NativeImageLike
}

/** 32-bpp BGRA with premultiplied alpha: what `nativeImage.createFromBitmap` expects. */
export interface PremultipliedBitmap {
  width: number
  height: number
  data: Buffer
}

const BYTES_PER_PIXEL = 4
const ALPHA = 3

function checkSize(icon: IconBitmap): void {
  const { width, height } = icon
  if (width <= 0 || height <= 0) throw new Error(`icon: empty (${width}x${height})`)
  const bytes = width * height * BYTES_PER_PIXEL
  if (icon.bgra.length !== bytes) {
    throw new Error(
      `icon: ${width}x${height} needs ${bytes} bytes of BGRA, got ${icon.bgra.length}`
    )
  }
  if (icon.mask !== null && icon.mask.length !== bytes) {
    throw new Error(
      `icon: ${width}x${height} needs ${bytes} bytes of mask, got ${icon.mask.length}`
    )
  }
}

function hasAlpha(bgra: Buffer): boolean {
  for (let i = ALPHA; i < bgra.length; i += BYTES_PER_PIXEL) if (bgra[i] !== 0) return true
  return false
}

/**
 * GetDIBits' straight-alpha BGRA → premultiplied BGRA (a new buffer). Legacy icons have no alpha
 * channel (every alpha byte is 0): their alpha comes from the AND mask, which GetDIBits renders
 * white where the icon is transparent and black where it is opaque. Without a mask such an icon
 * is fully opaque.
 */
export function premultiplyIcon(icon: IconBitmap): PremultipliedBitmap {
  checkSize(icon)
  const { bgra, mask } = icon
  const data = Buffer.from(bgra)
  const ownAlpha = hasAlpha(bgra)
  for (let i = 0; i < data.length; i += BYTES_PER_PIXEL) {
    let alpha = data[i + ALPHA]
    if (!ownAlpha) alpha = mask !== null && mask[i] !== 0 ? 0 : 255
    data[i + ALPHA] = alpha
    if (alpha === 255) continue
    for (let channel = 0; channel < ALPHA; channel++) {
      data[i + channel] = Math.round((data[i + channel] * alpha) / 255)
    }
  }
  return { width: icon.width, height: icon.height, data }
}

/** An extracted icon as PNG bytes, through Electron's nativeImage (premultiplied BGRA in). */
export function iconBitmapToPng(icon: IconBitmap, nativeImage: NativeImageFactory): Buffer {
  const { width, height, data } = premultiplyIcon(icon)
  const image = nativeImage.createFromBitmap(data, { width, height })
  const size = image.getSize()
  if (image.isEmpty() || size.width !== width || size.height !== height) {
    throw new Error(`icon: the image is ${size.width}x${size.height}, expected ${width}x${height}`)
  }
  return image.toPNG()
}
