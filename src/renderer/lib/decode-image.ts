/** Decodes the image at `url` and reports its natural size (physical pixels). */
export type ImageLoader = (url: string) => Promise<{ width: number; height: number }>

/**
 * The real loader: the image is fully decoded (off the main thread where the browser can) before
 * the caller swaps it in, so a new wallpaper never flashes in half-painted.
 */
export const decodeImage: ImageLoader = async (url) => {
  const image = new Image()
  image.decoding = 'async'
  const loaded =
    typeof image.decode === 'function'
      ? null
      : new Promise<void>((resolve, reject) => {
          image.onload = () => resolve()
          image.onerror = () => reject(new Error(`cannot load ${url}`))
        })
  image.src = url
  await (loaded ?? image.decode())
  return { width: image.naturalWidth, height: image.naturalHeight }
}
