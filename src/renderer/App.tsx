import { APP_NAME } from '@shared/app-info'
import type { Rect } from '@shared/schema'
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
  const info = useDisplayStore((state) => state.info)
  const peeking = useDisplayStore((state) => state.peeking)
  const itemCount = useItemsStore((state) =>
    state.hydrated ? Object.keys(state.byId).length : undefined
  )

  return (
    <>
      <ReadOnlyBanner />
      {/* The display this window covers, as main described it (read by tests and later layers). */}
      <main
        data-display-id={info?.id}
        data-display-bounds={info ? boundsAttribute(info.bounds) : undefined}
        data-scale-factor={info?.scaleFactor}
        data-peeking={peeking}
        data-desktop-items={itemCount}
        className="flex h-screen flex-col items-center justify-center gap-2 bg-background text-foreground select-none"
      >
        <h1 className="text-3xl font-semibold tracking-tight">{APP_NAME}</h1>
        <p className="text-sm text-muted-foreground">Your desktop, organized.</p>
      </main>
      <Toaster />
    </>
  )
}
