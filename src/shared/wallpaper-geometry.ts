// Where Windows puts a wallpaper image on one monitor, as CSS background properties. Pure: the
// renderer's WallpaperLayer calls it with the decoded image size and main's description of the
// display. Everything is computed in physical pixels (the unit Windows lays wallpapers out in)
// and converted to CSS pixels with the display's scale factor at the very end.

/** IDesktopWallpaper's DESKTOP_WALLPAPER_POSITION, by name. */
export type WallpaperPosition = 'center' | 'tile' | 'stretch' | 'fit' | 'fill' | 'span'

export interface PxSize {
  width: number
  height: number
}

/** A rectangle in physical pixels (virtual-screen coordinates). */
export interface PxRect extends PxSize {
  x: number
  y: number
}

export interface WallpaperGeometryInput {
  /** The decoded image's natural size (pixels). */
  image: PxSize
  position: WallpaperPosition
  /** The monitor this layer covers, in physical pixels. */
  display: PxRect
  /** The bounding box of every monitor, in physical pixels (`span` covers it). */
  virtualScreen: PxRect
  /** CSS pixels per physical pixel on this display (Electron's `scaleFactor`). */
  scaleFactor: number
}

/** The image's box relative to the display's top-left corner, in physical pixels. */
export interface WallpaperPlacement extends PxRect {
  repeat: boolean
}

export interface WallpaperCss {
  backgroundSize: string
  backgroundPosition: string
  backgroundRepeat: 'repeat' | 'no-repeat'
}

/** `image` scaled by `scale` and centred in `box`; returns its top-left and size. */
function centred(image: PxSize, box: PxRect, scale: number): PxRect {
  const width = image.width * scale
  const height = image.height * scale
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height }
}

/** Scale that makes `image` cover (`max`) or fit inside (`min`) `box`; 0 for an empty image. */
function scaleTo(image: PxSize, box: PxSize, pick: (a: number, b: number) => number): number {
  if (image.width <= 0 || image.height <= 0) return 0
  return pick(box.width / image.width, box.height / image.height)
}

export function wallpaperPlacement(input: WallpaperGeometryInput): WallpaperPlacement {
  const { image, position, display, virtualScreen } = input
  // Boxes relative to the display's own origin.
  const own: PxRect = { x: 0, y: 0, width: display.width, height: display.height }
  let box: PxRect
  switch (position) {
    case 'fill':
      box = centred(image, own, scaleTo(image, own, Math.max))
      break
    case 'fit':
      box = centred(image, own, scaleTo(image, own, Math.min))
      break
    case 'stretch':
      box = own
      break
    case 'center':
      box = centred(image, own, 1)
      break
    case 'tile':
      // Tiles start at each monitor's top-left corner, at the image's own pixel size.
      return { x: 0, y: 0, width: image.width, height: image.height, repeat: true }
    case 'span': {
      // One image covers the bounding box of all monitors; each shows its own slice of it.
      const virtual: PxRect = {
        ...virtualScreen,
        x: virtualScreen.x - display.x,
        y: virtualScreen.y - display.y
      }
      box = centred(image, virtual, scaleTo(image, virtual, Math.max))
      break
    }
  }
  return { ...box, repeat: false }
}

/** CSS lengths: at most 3 decimals, no `-0`. */
function px(value: number): string {
  const rounded = Math.round(value * 1000) / 1000
  return `${rounded === 0 ? 0 : rounded}px`
}

/** `wallpaperPlacement` as `background-size/position/repeat` in CSS pixels. */
export function wallpaperCss(input: WallpaperGeometryInput): WallpaperCss {
  const placement = wallpaperPlacement(input)
  const scale = input.scaleFactor > 0 ? input.scaleFactor : 1
  return {
    backgroundSize: `${px(placement.width / scale)} ${px(placement.height / scale)}`,
    backgroundPosition: `${px(placement.x / scale)} ${px(placement.y / scale)}`,
    backgroundRepeat: placement.repeat ? 'repeat' : 'no-repeat'
  }
}

/** The bounding box of `rects` (the virtual screen); an empty rect for none. */
export function virtualScreenOf(rects: readonly PxRect[]): PxRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  const left = Math.min(...rects.map((r) => r.x))
  const top = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}
