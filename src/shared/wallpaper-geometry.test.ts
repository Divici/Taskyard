import { describe, expect, it } from 'vitest'
import {
  virtualScreenOf,
  wallpaperCss,
  wallpaperPlacement,
  type WallpaperGeometryInput
} from './wallpaper-geometry'

// This machine: 2560×1440 primary at 0,0 and 1920×1080 at x=2560 (physical px).
const PRIMARY = { x: 0, y: 0, width: 2560, height: 1440 }
const SECONDARY = { x: 2560, y: 0, width: 1920, height: 1080 }
const VIRTUAL = { x: 0, y: 0, width: 4480, height: 1440 }
const ULTRAWIDE = { width: 2560, height: 1080 }

function input(overrides: Partial<WallpaperGeometryInput>): WallpaperGeometryInput {
  return {
    image: ULTRAWIDE,
    position: 'fill',
    display: PRIMARY,
    virtualScreen: VIRTUAL,
    scaleFactor: 1,
    ...overrides
  }
}

describe('wallpaperPlacement', () => {
  it('fill scales to cover the display and crops the overflow, centred', () => {
    expect(wallpaperPlacement(input({ position: 'fill', display: SECONDARY }))).toEqual({
      x: -320,
      y: 0,
      width: 2560,
      height: 1080,
      repeat: false
    })
    // Taller display than the image's aspect: scaled up, cropped left and right.
    expect(wallpaperPlacement(input({ position: 'fill' }))).toEqual({
      x: (2560 - 2560 * (1440 / 1080)) / 2,
      y: 0,
      width: 2560 * (1440 / 1080),
      height: 1440,
      repeat: false
    })
  })

  it('fit scales to fit inside the display and letterboxes, centred', () => {
    expect(wallpaperPlacement(input({ position: 'fit' }))).toEqual({
      x: 0,
      y: 180,
      width: 2560,
      height: 1080,
      repeat: false
    })
    expect(wallpaperPlacement(input({ position: 'fit', display: SECONDARY }))).toEqual({
      x: 0,
      y: 135,
      width: 1920,
      height: 810,
      repeat: false
    })
  })

  it('stretch fills the display exactly, ignoring the aspect ratio', () => {
    expect(wallpaperPlacement(input({ position: 'stretch', display: SECONDARY }))).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      repeat: false
    })
  })

  it('center keeps the image at its own pixel size, centred (cropped when larger)', () => {
    expect(wallpaperPlacement(input({ position: 'center', display: SECONDARY }))).toEqual({
      x: -320,
      y: 0,
      width: 2560,
      height: 1080,
      repeat: false
    })
    const small = { width: 800, height: 600 }
    expect(wallpaperPlacement(input({ position: 'center', image: small }))).toEqual({
      x: 880,
      y: 420,
      width: 800,
      height: 600,
      repeat: false
    })
  })

  it('tile repeats the image at its own pixel size from the display origin', () => {
    const tileImage = { width: 64, height: 48 }
    expect(
      wallpaperPlacement(input({ position: 'tile', image: tileImage, display: SECONDARY }))
    ).toEqual({ x: 0, y: 0, width: 64, height: 48, repeat: true })
  })

  it('span covers the whole virtual screen and offsets each display by its origin', () => {
    // 4480×1440 virtual screen: scale max(4480/2560, 1440/1080) = 1.75 → 4480×1890, 225 px
    // cropped at the top and at the bottom.
    const primary = wallpaperPlacement(input({ position: 'span' }))
    const secondary = wallpaperPlacement(input({ position: 'span', display: SECONDARY }))
    expect(primary).toEqual({ x: 0, y: -225, width: 4480, height: 1890, repeat: false })
    expect(secondary).toEqual({ x: -2560, y: -225, width: 4480, height: 1890, repeat: false })
  })

  it('span honours a virtual screen that starts left of the primary display', () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1080 }
    const virtualScreen = virtualScreenOf([left, PRIMARY])
    expect(virtualScreen).toEqual({ x: -1920, y: 0, width: 4480, height: 1440 })
    expect(
      wallpaperPlacement(input({ position: 'span', display: PRIMARY, virtualScreen }))
    ).toEqual({ x: -1920, y: -225, width: 4480, height: 1890, repeat: false })
  })

  it('never divides by zero on an empty image', () => {
    const placement = wallpaperPlacement(input({ position: 'fit', image: { width: 0, height: 0 } }))
    expect(placement.width).toBe(0)
    expect(Number.isFinite(placement.x)).toBe(true)
  })
})

describe('wallpaperCss', () => {
  it('turns physical pixels into CSS pixels with the display scale factor', () => {
    // 150 %: a centred 2560×1080 image is 1706.667×720 CSS px on a 1706.667×960 CSS px display.
    expect(wallpaperCss(input({ position: 'center', scaleFactor: 1.5 }))).toEqual({
      backgroundSize: '1706.667px 720px',
      backgroundPosition: '0px 120px',
      backgroundRepeat: 'no-repeat'
    })
  })

  it('repeats a tiled wallpaper and does not repeat any other mode', () => {
    expect(wallpaperCss(input({ position: 'tile' })).backgroundRepeat).toBe('repeat')
    for (const position of ['fill', 'fit', 'stretch', 'center', 'span'] as const) {
      expect(wallpaperCss(input({ position })).backgroundRepeat).toBe('no-repeat')
    }
  })

  it('writes fit on this machine as a letterboxed band', () => {
    expect(wallpaperCss(input({ position: 'fit' }))).toEqual({
      backgroundSize: '2560px 1080px',
      backgroundPosition: '0px 180px',
      backgroundRepeat: 'no-repeat'
    })
  })
})
