import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WallpaperInfo } from '@shared/ipc'
import { createFakeBridge, installFakeBridge, type FakeBridge } from '../../test/fake-bridge'
import { useWallpaperStore } from '../../stores/wallpaper'
import type { ImageLoader } from '../../lib/decode-image'
import { WallpaperLayer } from './WallpaperLayer'

const PRIMARY_PX = { x: 0, y: 0, width: 2560, height: 1440 }

function info(version: number, overrides: Partial<WallpaperInfo> = {}): WallpaperInfo {
  return {
    displayId: 1,
    version,
    url: `taskyard://wallpaper/1?v=${version}`,
    position: 'fit',
    color: '#000000',
    scaleFactor: 1,
    displayRectPx: PRIMARY_PX,
    virtualRectPx: { x: 0, y: 0, width: 4480, height: 1440 },
    hint: null,
    ...overrides
  }
}

/** An image loader the test resolves by hand: every URL asked for, and a way to finish it. */
function manualLoader(size = { width: 2560, height: 1080 }): {
  load: ImageLoader
  requested: string[]
  finish(url: string): Promise<void>
  fail(url: string): Promise<void>
} {
  const pending = new Map<
    string,
    { resolve: (s: typeof size) => void; reject: (e: Error) => void }
  >()
  const requested: string[] = []
  return {
    requested,
    load: vi.fn(
      (url: string) =>
        new Promise<typeof size>((resolve, reject) => {
          requested.push(url)
          pending.set(url, { resolve, reject })
        })
    ),
    async finish(url) {
      await act(async () => pending.get(url)?.resolve(size))
    },
    async fail(url) {
      await act(async () => pending.get(url)?.reject(new Error('decode failed')))
    }
  }
}

function setup(first: WallpaperInfo = info(1)): FakeBridge {
  const bridge = installFakeBridge(createFakeBridge())
  bridge.wallpaper.get.mockResolvedValue(first)
  return bridge
}

const layer = (): HTMLElement => screen.getByTestId('wallpaper-layer')

describe('WallpaperLayer', () => {
  it("paints this display's wallpaper at its fit mode once the image has decoded", async () => {
    const bridge = setup()
    const loader = manualLoader()
    render(<WallpaperLayer displayId={1} loadImage={loader.load} />)

    await waitFor(() => expect(loader.requested).toEqual(['taskyard://wallpaper/1?v=1']))
    expect(bridge.wallpaper.get).toHaveBeenCalledWith(1)
    // Colour first: no half-loaded image is ever shown.
    expect(layer().style.backgroundImage).toBe('')
    expect(layer().style.backgroundColor).toBe('rgb(0, 0, 0)')

    await loader.finish('taskyard://wallpaper/1?v=1')
    expect(layer().style.backgroundImage).toBe('url("taskyard://wallpaper/1?v=1")')
    expect(layer().style.backgroundSize).toBe('2560px 1080px')
    expect(layer().style.backgroundPosition).toBe('0px 180px')
    expect(layer().style.backgroundRepeat).toBe('no-repeat')
    // Sized to the whole display (the window itself is 1 px shorter).
    expect(layer().style.width).toBe('2560px')
    expect(layer().style.height).toBe('1440px')
    expect(layer()).toHaveAttribute('data-wallpaper-version', '1')
    expect(layer()).toHaveAttribute('aria-hidden', 'true')
  })

  it('re-requests ?v=2 after a wallpaper:changed event for its display', async () => {
    const bridge = setup()
    const loader = manualLoader()
    render(<WallpaperLayer displayId={1} loadImage={loader.load} />)
    await waitFor(() => expect(loader.requested).toHaveLength(1))
    await loader.finish('taskyard://wallpaper/1?v=1')

    bridge.wallpaper.get.mockResolvedValue(info(2))
    act(() => bridge.emit('wallpaper:changed', { displayId: 1, version: 2 }))

    await waitFor(() =>
      expect(loader.requested).toEqual(['taskyard://wallpaper/1?v=1', 'taskyard://wallpaper/1?v=2'])
    )
    expect(bridge.wallpaper.get).toHaveBeenCalledTimes(2)
    // The old picture stays up until the new one has decoded: no flash of colour.
    expect(layer().style.backgroundImage).toBe('url("taskyard://wallpaper/1?v=1")')
    await loader.finish('taskyard://wallpaper/1?v=2')
    expect(layer().style.backgroundImage).toBe('url("taskyard://wallpaper/1?v=2")')
    expect(layer()).toHaveAttribute('data-wallpaper-version', '2')
  })

  it("ignores another display's change", async () => {
    const bridge = setup()
    const loader = manualLoader()
    render(<WallpaperLayer displayId={1} loadImage={loader.load} />)
    await waitFor(() => expect(bridge.wallpaper.get).toHaveBeenCalledTimes(1))
    act(() => bridge.emit('wallpaper:changed', { displayId: 2, version: 7 }))
    await act(async () => {})
    expect(bridge.wallpaper.get).toHaveBeenCalledTimes(1)
  })

  it('shows only the desktop colour when Windows has no picture, with the hint exposed', async () => {
    setup(info(1, { url: null, color: '#0063b1', hint: 'solid-color' }))
    const loader = manualLoader()
    render(<WallpaperLayer displayId={1} loadImage={loader.load} />)
    await waitFor(() => expect(layer()).toHaveAttribute('data-wallpaper-hint', 'solid-color'))
    expect(layer().style.backgroundColor).toBe('rgb(0, 99, 177)')
    expect(layer().style.backgroundImage).toBe('')
    expect(loader.load).not.toHaveBeenCalled()
    expect(useWallpaperStore.getState().info?.hint).toBe('solid-color')
  })

  it('falls back to the colour when the image cannot be decoded (logged once)', async () => {
    setup()
    const loader = manualLoader()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<WallpaperLayer displayId={1} loadImage={loader.load} />)
    await waitFor(() => expect(loader.requested).toHaveLength(1))
    await loader.fail('taskyard://wallpaper/1?v=1')
    expect(layer().style.backgroundImage).toBe('')
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toContain('wallpaper: taskyard://wallpaper/1?v=1 did not load')
  })

  it('drops a slow older image that finishes after a newer one', async () => {
    const bridge = setup()
    const loader = manualLoader()
    render(<WallpaperLayer displayId={1} loadImage={loader.load} />)
    await waitFor(() => expect(loader.requested).toHaveLength(1))
    bridge.wallpaper.get.mockResolvedValue(info(2))
    act(() => bridge.emit('wallpaper:changed', { displayId: 1, version: 2 }))
    await waitFor(() => expect(loader.requested).toHaveLength(2))

    await loader.finish('taskyard://wallpaper/1?v=2')
    await loader.finish('taskyard://wallpaper/1?v=1')
    expect(layer().style.backgroundImage).toBe('url("taskyard://wallpaper/1?v=2")')
  })

  it('renders nothing but the colour without a display id, and stops listening on unmount', async () => {
    const bridge = setup()
    const { unmount } = render(<WallpaperLayer displayId={null} loadImage={manualLoader().load} />)
    expect(layer().style.backgroundImage).toBe('')
    expect(bridge.wallpaper.get).not.toHaveBeenCalled()
    unmount()

    render(<WallpaperLayer displayId={1} loadImage={manualLoader().load} />).unmount()
    expect(bridge.listenerCount('wallpaper:changed')).toBe(0)
  })
})
