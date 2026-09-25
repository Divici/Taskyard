import { useEffect, useState, type CSSProperties } from 'react'
import { wallpaperCss } from '@shared/wallpaper-geometry'
import { getBridge } from '../../lib/bridge'
import { decodeImage, type ImageLoader } from '../../lib/decode-image'
import { connectWallpaper } from '../../lib/wallpaper-sync'
import { useWallpaperStore } from '../../stores/wallpaper'

export interface WallpaperLayerProps {
  /** The display this window covers (from its URL); null paints only black. */
  displayId: number | null
  /** Injected in tests (jsdom decodes no images). */
  loadImage?: ImageLoader
}

interface Decoded {
  url: string
  version: number
  width: number
  height: number
}

const FALLBACK_COLOR = '#000000'

/**
 * The bottom layer of every desktop window: this monitor's wallpaper, placed exactly as Windows
 * places it (fill/fit/stretch/center/tile/span), over the desktop colour. Everything else sits
 * above it, and glass blurs it (`backdrop-filter`), so hiding the layers above (quick-hide)
 * reveals the plain wallpaper. A new picture replaces the old one only once it has decoded.
 */
export function WallpaperLayer({
  displayId,
  loadImage = decodeImage
}: WallpaperLayerProps): React.JSX.Element {
  const info = useWallpaperStore((state) => state.info)
  const [decoded, setDecoded] = useState<Decoded | null>(null)

  useEffect(() => {
    if (displayId === null) return
    let api
    try {
      api = getBridge()
    } catch (error) {
      console.error('wallpaper: no bridge to main', error)
      return
    }
    return connectWallpaper(api, displayId)
  }, [displayId])

  const url = info?.url ?? null
  const version = info?.version ?? 0
  useEffect(() => {
    if (url === null) return
    let current = true
    loadImage(url).then(
      (size) => {
        if (current) setDecoded({ url, version, ...size })
      },
      (error: unknown) => {
        if (!current) return
        console.error(`wallpaper: ${url} did not load; showing the desktop colour`, error)
        setDecoded(null)
      }
    )
    return () => {
      current = false
    }
  }, [url, version, loadImage])

  const style: CSSProperties = {
    backgroundColor: info?.color ?? FALLBACK_COLOR,
    width: '100%',
    height: '100%'
  }
  // Until the new picture decodes the previous one stays up; no picture at all → colour only.
  if (info !== null && url !== null && decoded !== null) {
    Object.assign(
      style,
      { backgroundImage: `url("${decoded.url}")` },
      wallpaperCss({
        image: decoded,
        position: info.position,
        display: info.displayRectPx,
        virtualScreen: info.virtualRectPx,
        scaleFactor: info.scaleFactor
      })
    )
  }
  if (info !== null) {
    // The whole display, even though the window stops 1 px short of its bottom edge.
    style.width = `${info.displayRectPx.width / info.scaleFactor}px`
    style.height = `${info.displayRectPx.height / info.scaleFactor}px`
  }

  return (
    <div
      data-testid="wallpaper-layer"
      data-wallpaper-version={decoded !== null && url !== null ? decoded.version : undefined}
      data-wallpaper-hint={info?.hint ?? undefined}
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-0 -z-10"
      style={style}
    />
  )
}
