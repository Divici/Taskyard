import { LayoutGrid } from 'lucide-react'
import type { Rect } from '@shared/schema'

export interface EmptyHintProps {
  /** The work area (window coordinates): the card sits at its bottom centre. */
  area: Rect
  onAutoOrganize(): void
  onDismiss(): void
}

const WIDTH = 380

/**
 * Shown while a desktop has icons but no groups yet: one click organizes them by type, or the
 * user makes their own groups (right-click, or a right-button drag).
 */
export function EmptyHint({ area, onAutoOrganize, onDismiss }: EmptyHintProps): React.JSX.Element {
  return (
    <section
      aria-label="Tidy up your desktop"
      data-peek-keep=""
      className="glass absolute z-[9000] flex flex-col gap-3 p-5"
      style={{
        width: WIDTH,
        left: area.x + area.width / 2 - WIDTH / 2,
        top: area.y + area.height - 32,
        transform: 'translateY(-100%)'
      }}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-[10px] bg-accent-1/15 text-accent-1">
          <LayoutGrid aria-hidden="true" className="size-4" />
        </span>
        <h2 className="text-[15px] font-semibold tracking-tight">Tidy up your desktop</h2>
      </div>
      <p className="text-[13px] leading-relaxed text-text-secondary">
        Group your icons by type in one click, or make your own: right-click the desktop and choose{' '}
        <span className="text-text-primary">New group here</span>, or drag with the right mouse
        button to draw one.
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-[10px] px-3.5 py-1.5 text-[13px] text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:outline-none"
        >
          Not now
        </button>
        <button
          type="button"
          onClick={onAutoOrganize}
          className="rounded-[10px] bg-gradient-to-r from-accent-2 to-accent-1 px-3.5 py-1.5 text-[13px] font-semibold text-black shadow-[0_4px_16px_rgb(0_119_255/0.35)] transition-[filter] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
        >
          Auto-organize
        </button>
      </div>
    </section>
  )
}
