import { useUiStore } from '../../stores/ui'

/** The rubber band: a thin cyan outline over a faint fill. */
export function Marquee(): React.JSX.Element | null {
  const band = useUiStore((state) => state.marquee)
  if (!band) return null
  return (
    <div
      data-marquee=""
      aria-hidden="true"
      className="pointer-events-none absolute z-[9999] rounded-[4px] border border-accent-1/80 bg-accent-1/10 shadow-[0_0_12px_rgb(0_242_255/0.25)]"
      style={{ left: band.x, top: band.y, width: band.width, height: band.height }}
    />
  )
}
