import { ListTodo, Timer } from 'lucide-react'
import { useRef } from 'react'
import { cn } from '../../lib/utils'
import { TOOL_IDS, TOOL_LABELS, type ToolId } from './tools-geometry'

export interface ToolRailProps {
  active: ToolId
  onChange(tool: ToolId): void
  /** A countdown is running: the Timer tab wears a glowing accent dot. */
  timerRunning: boolean
  /** Prefix of the tab ids (`<prefix>-tab-<tool>`) and the panel id (`<prefix>-panel`). */
  idPrefix: string
}

const ICONS: Readonly<Record<ToolId, typeof ListTodo>> = { tasks: ListTodo, timer: Timer }

/** Keys that move between tabs, and where they go from `index`. */
function nextIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return (index + 1) % count
    case 'ArrowUp':
    case 'ArrowLeft':
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
 * The tools widget's side rail: a dark vertical pill of round tool buttons, the active one ringed
 * with the accent glow (the tool bar in design/taskbarDesign.jpg, stood on end). ARIA tabs with a
 * roving tab stop: arrow keys (either axis), Home and End switch tools and move focus.
 */
export function ToolRail({
  active,
  onChange,
  timerRunning,
  idPrefix
}: ToolRailProps): React.JSX.Element {
  const tabs = useRef<Array<HTMLButtonElement | null>>([])

  return (
    <div
      role="tablist"
      aria-label="Tools"
      aria-orientation="vertical"
      className="flex shrink-0 flex-col items-center gap-2 self-start rounded-full bg-[rgb(12_17_28/0.72)] p-1.5 shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_6px_18px_rgb(0_0_0/0.28)]"
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
        const Icon = ICONS[tool]
        const selected = tool === active
        const running = tool === 'timer' && timerRunning
        return (
          <button
            key={tool}
            ref={(node) => {
              tabs.current[index] = node
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tool}`}
            aria-label={TOOL_LABELS[tool]}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            aria-describedby={running ? `${idPrefix}-running` : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tool)}
            className={cn(
              'relative flex size-9 items-center justify-center rounded-full transition-[background-color,box-shadow,color] duration-[180ms]',
              'focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:outline-none',
              selected
                ? 'bg-[rgb(20_28_44/0.9)] text-accent-1 shadow-[0_0_0_2px_var(--accent-1),0_0_14px_2px_color-mix(in_srgb,var(--accent-1)_55%,transparent)]'
                : 'bg-white/12 text-white/70 hover:bg-white/20 hover:text-white'
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            {running && (
              <>
                <span
                  data-running-badge=""
                  aria-hidden="true"
                  className="absolute top-0.5 right-0.5 size-2 rounded-full bg-accent-1 shadow-[0_0_6px_2px_var(--accent-1)] motion-safe:animate-pulse"
                />
                <span id={`${idPrefix}-running`} className="sr-only">
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
