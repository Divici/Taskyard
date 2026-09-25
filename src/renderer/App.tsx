import { APP_NAME } from '@shared/app-info'
import type { Rect } from '@shared/schema'
import { WallpaperLayer } from './components/canvas/WallpaperLayer'
import { LooseItemsGrid } from './components/desktop/LooseItemsGrid'
import { ReadOnlyBanner } from './components/feedback/ReadOnlyBanner'
import { Toaster } from './components/feedback/Toaster'
import { useBridgeSync } from './lib/use-bridge-sync'
import { useDisplayStore } from './stores/display'
import { useItemsStore } from './stores/items'

const boundsAttribute = ({ x, y, width, height }: Rect): string => `${x},${y},${width},${height}`

export default function App(): React.JSX.Element {
  // Hydrates settings/layout/tasks from main, connects this window to its display and subscribes
  // the stores to main's events for as long as the app is mounted.
  useBridgeSync()
  const displayId = useDisplayStore((state) => state.displayId)
  const info = useDisplayStore((state) => state.info)
  const peeking = useDisplayStore((state) => state.peeking)
  const itemCount = useItemsStore((state) =>
    state.hydrated ? Object.keys(state.byId).length : undefined
  )

  return (
    <>
      {/* Bottom layer: this monitor's wallpaper. Everything else stacks above it and glass blurs
          it; hiding the layers above (quick-hide) shows the plain wallpaper. */}
      <WallpaperLayer displayId={displayId} />
      <ReadOnlyBanner />
      {/* The display this window covers, as main described it (read by tests and later layers). */}
      <main
        data-display-id={info?.id}
        data-display-bounds={info ? boundsAttribute(info.bounds) : undefined}
        data-scale-factor={info?.scaleFactor}
        data-peeking={peeking}
        data-desktop-items={itemCount}
        className="relative h-screen overflow-hidden select-none"
      >
        {/* Phase 5 stand-in over the wallpaper: every item with its icon. Phase 7 replaces it
            with the canvas. */}
        <LooseItemsGrid />
        {/* Phase 6's glass placeholder, shrunk to a label so the items stay visible. */}
        <div className="glass pointer-events-none absolute right-4 bottom-3 px-4 py-2">
          <h1 className="text-sm font-semibold tracking-tight">{APP_NAME}</h1>
        </div>
      </main>
      <Toaster />
    </>
  )
}
