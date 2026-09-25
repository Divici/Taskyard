import { APP_NAME } from '@shared/app-info'
import type { Rect } from '@shared/schema'
import { DesktopCanvas } from './components/canvas/DesktopCanvas'
import { WallpaperLayer } from './components/canvas/WallpaperLayer'
import { ConfirmHost } from './components/feedback/ConfirmDialog'
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
        <h1 className="sr-only">{APP_NAME}</h1>
        {/* The desktop itself: loose icons, groups, marquee and menus, once main has said which
            display this window covers. */}
        {info !== null && info.id === displayId && (
          <DesktopCanvas displayId={info.id} info={info} />
        )}
      </main>
      <ConfirmHost />
      <Toaster />
    </>
  )
}
