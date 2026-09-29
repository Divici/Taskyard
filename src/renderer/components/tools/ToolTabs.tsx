import { useRef } from 'react'
import { cn } from '../../lib/utils'
import { TOOL_IDS, TOOL_LABELS, type ToolId } from './tools-geometry'

export interface ToolTabsProps {
  active: ToolId
  onChange(tool: ToolId): void
  /** Tools counting right now (the timer, the stopwatch): their tab wears a glowing dot. */
  running: Readonly<Partial<Record<ToolId, boolean>>>
  /** Prefix of the tab ids (`<prefix>-tab-<tool>`) and the panel id (`<prefix>-panel`). */
  idPrefix: string
}

/** Keys that move between tabs, and where they go from `index`. */
function nextIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/**
 * The tools widget's tab switcher (round 2: at the top, replacing the side rail): a centred
 * segmented pill — Tasks · Timer · Stopwatch — the selected segment lit with the accent glow
 * (the nav pills of design/designInpo.html, the glow of design/taskbarDesign.jpg). ARIA tabs
 * with a roving tab stop: arrow keys, Home and End switch tools and move focus. The names are
 * text only, and a running tool's dot sits in the tab's corner (out of the text flow), so each
 * name stays centred and whole down to the widget's 280 px minimum.
 */
export function ToolTabs({
  active,
  onChange,
  running,
  idPrefix
}: ToolTabsProps): React.JSX.Element {
  const tabs = useRef<Array<HTMLButtonElement | null>>([])

  return (
    <div
      role="tablist"
      aria-label="Tools"
      aria-orientation="horizontal"
      className={cn(
        'mx-auto flex w-full max-w-[300px] shrink-0 items-center gap-0.5 rounded-full border p-0.5',
        'border-white/10 bg-[rgb(12_17_28/0.72)] shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_6px_18px_rgb(0_0_0/0.28)]',
        '[[data-theme=light]_&]:border-black/10 [[data-theme=light]_&]:bg-black/[0.06] [[data-theme=light]_&]:shadow-[inset_0_1px_2px_rgb(0_0_0/0.06)]'
      )}
      onKeyDown={(event) => {
        const index = TOOL_IDS.indexOf(active)
        const next = nextIndex(event.key, index, TOOL_IDS.length)
        if (next === null) return
        event.preventDefault()
        event.stopPropagation()
        onChange(TOOL_IDS[next])
        tabs.current[next]?.focus()
      }}
    >
      {TOOL_IDS.map((tool, index) => {
        const selected = tool === active
        const counting = running[tool] === true
        return (
          <button
            key={tool}
            ref={(node) => {
              tabs.current[index] = node
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tool}`}
            // The name stays the tool name (the "Running" note inside is its description).
            aria-label={TOOL_LABELS[tool]}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            aria-describedby={counting ? `${idPrefix}-running-${tool}` : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tool)}
            className={cn(
              'relative flex h-7 min-w-0 flex-1 items-center justify-center rounded-full px-1.5 text-[12px] font-semibold',
              'transition-[background-color,box-shadow,color] duration-[180ms]',
              'focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:outline-none',
              selected
                ? cn(
                    'bg-[rgb(20_28_44/0.95)] text-accent-1 shadow-[0_0_0_1.5px_var(--accent-1),0_0_14px_1px_color-mix(in_srgb,var(--accent-1)_50%,transparent)]',
                    '[[data-theme=light]_&]:bg-white [[data-theme=light]_&]:shadow-[0_0_0_1.5px_var(--accent-1),0_2px_10px_color-mix(in_srgb,var(--accent-1)_35%,transparent)]'
                  )
                : 'text-white/65 hover:bg-white/10 hover:text-white [[data-theme=light]_&]:text-text-secondary [[data-theme=light]_&]:hover:bg-black/5 [[data-theme=light]_&]:hover:text-text-primary'
            )}
          >
            <span data-tab-label="" className="truncate">
              {TOOL_LABELS[tool]}
            </span>
            {counting && (
              <>
                <span
                  data-running-badge=""
                  aria-hidden="true"
                  className="absolute top-[3px] right-[5px] size-1.5 rounded-full bg-accent-1 shadow-[0_0_6px_2px_var(--accent-1)] motion-safe:animate-pulse"
                />
                <span id={`${idPrefix}-running-${tool}`} className="sr-only">
                  Running
                </span>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}
