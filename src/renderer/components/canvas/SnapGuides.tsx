import { useUiStore } from '../../stores/ui'

/**
 * Round 2: the thin accent lines that show what a moving or resizing window lines up with. Drawn
 * at the canvas root (a `.glass` box would clip them), above every window, never hit-testable.
 */
export function SnapGuides({ zIndex }: { zIndex: number }): React.JSX.Element | null {
  const guides = useUiStore((state) => state.snapGuides)
  if (guides.length === 0) return null
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ zIndex }}>
      {guides.map((guide) => (
        <span
          key={`${guide.axis}:${guide.at}`}
          data-snap-guide={`${guide.axis}:${guide.at}`}
          className="absolute bg-accent-1 shadow-[0_0_6px_var(--color-accent-1)]"
          style={
            guide.axis === 'x'
              ? { left: guide.at - 0.5, top: guide.from, width: 1, height: guide.to - guide.from }
              : { top: guide.at - 0.5, left: guide.from, height: 1, width: guide.to - guide.from }
          }
        />
      ))}
    </div>
  )
}
