import { useId, useRef, useState } from 'react'
import { GROUP_HEADER_HEIGHT } from '@shared/group-metrics'
import type { Rect, TimerState } from '@shared/schema'
import { formatClock } from '@shared/timer-state'
import { cn } from '../../lib/utils'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { useTasksStore } from '../../stores/tasks'
import { GroupHeader } from '../group/GroupHeader'
import { ResizeHandles } from '../group/ResizeHandles'
import { useGroupDrag } from '../group/useGroupDrag'
import { TimerTool } from './timer/TimerTool'
import { useTimerTick } from './timer/useTimerTick'
import { TodoTool } from './todo/TodoTool'
import { ToolRail } from './ToolRail'
import { ToolsContextMenu } from './ToolsContextMenu'
import { patchTools, TOOL_LABELS, TOOLS_MIN_SIZE, toolsRect, type ToolId } from './tools-geometry'

export interface ToolsWidgetProps {
  displayId: number
  /** The display's work area in window coordinates: edges never leave it. */
  area: Rect
  /** CSS stacking order (above the groups). */
  zIndex: number
  /** Quick-hide: faded out and inert, like the groups. */
  hidden?: boolean
}

/** The remaining time in the header while a countdown is in progress (it ticks on its own). */
function HeaderTime({ timer }: { timer: TimerState }): React.JSX.Element {
  const remaining = useTimerTick(timer)
  return (
    <span
      role="timer"
      aria-live="off"
      aria-label="Time left"
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[12px] font-semibold text-accent-1 tabular-nums',
        'bg-accent-1/10 shadow-[0_0_10px_color-mix(in_srgb,var(--accent-1)_30%,transparent)]',
        timer.status === 'paused' && 'opacity-60'
      )}
    >
      {formatClock(remaining)}
    </span>
  )
}

/**
 * The floating tools widget (Decision 6 + its 2026-09-23 extension): the group chrome — title
 * bar drag, 8 resize handles (min 280 × 220), roll-up, quick-hide — around a side tool rail and
 * the active tool (Tasks or Timer). Its rect, roll-up and active tool are saved per display
 * (layout `tools`); moves and resizes preview locally and save once, on release. The header
 * names the active tool; rolled up (or on the Tasks tool) it shows the countdown's time left.
 */
export function ToolsWidget({
  displayId,
  area,
  zIndex,
  hidden = false
}: ToolsWidgetProps): React.JSX.Element | null {
  const tools = useLayoutStore(
    (state) => state.layout.displays.find((display) => display.displayId === displayId)?.tools
  )
  const timer = useTasksStore((state) => state.timer)
  const snap = useSettingsStore((state) => state.settings.gridSnap)
  const [draft, setDraft] = useState<Rect | null>(null)
  const [resizing, setResizing] = useState(false)
  const element = useRef<HTMLElement>(null)
  const idPrefix = `tools-${useId().replace(/:/g, '')}`

  const update = (patch: Parameters<typeof patchTools>[0]): void =>
    useLayoutStore.getState().updateTools(displayId, patchTools(patch))

  const saved = tools ? toolsRect(tools) : { x: 0, y: 0, width: 0, height: 0 }
  const drag = useGroupDrag({
    rect: saved,
    area,
    snap,
    onDrag: setDraft,
    onDragEnd(final) {
      setDraft(null)
      update({ x: final.x, y: final.y })
    }
  })

  if (!tools) return null
  const rect = draft ?? saved
  const active: ToolId = tools.activeTool
  const counting = timer.status === 'running' || timer.status === 'paused'
  const showTime = counting && (tools.rolledUp || active !== 'timer')

  const openMenu = (anchor: DOMRect): void => {
    element.current?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: anchor.left,
        clientY: anchor.bottom
      })
    )
  }

  return (
    <ToolsContextMenu displayId={displayId} activeTool={active} rolledUp={tools.rolledUp}>
      <section
        ref={element}
        role="region"
        aria-label="Tools"
        aria-hidden={hidden || undefined}
        inert={hidden}
        data-tools-widget={displayId}
        // Phase 9: clicks and typing here keep a Peek open (lib/peek-sync.ts).
        data-peek-keep=""
        data-rolled-up={tools.rolledUp || undefined}
        data-dragging={drag.dragging || resizing || undefined}
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: tools.rolledUp ? GROUP_HEADER_HEIGHT : rect.height,
          zIndex
        }}
        className={cn(
          'glass absolute flex flex-col transition-[opacity,border-color] duration-[180ms] hover:border-accent-1/50',
          hidden && 'pointer-events-none opacity-0'
        )}
      >
        <GroupHeader
          title={TOOL_LABELS[active]}
          rolledUp={tools.rolledUp}
          renaming={false}
          drag={drag.handlers}
          dragging={drag.dragging}
          onToggleRollUp={() => update({ rolledUp: !tools.rolledUp })}
          onOpenMenu={openMenu}
          menuLabel="Tools options"
        >
          {showTime && <HeaderTime timer={timer} />}
        </GroupHeader>
        {!tools.rolledUp && (
          <div className="flex min-h-0 flex-1 gap-3 p-3 pl-2.5">
            <ToolRail
              active={active}
              onChange={(tool) => update({ activeTool: tool })}
              timerRunning={timer.status === 'running'}
              idPrefix={idPrefix}
            />
            <div
              role="tabpanel"
              id={`${idPrefix}-panel`}
              aria-labelledby={`${idPrefix}-tab-${active}`}
              className="min-h-0 min-w-0 flex-1"
            >
              {active === 'tasks' ? <TodoTool /> : <TimerTool />}
            </div>
          </div>
        )}
        <ResizeHandles
          rect={saved}
          area={area}
          min={TOOLS_MIN_SIZE}
          snap={snap}
          rolledUp={tools.rolledUp}
          onResizeStart={() => setResizing(true)}
          onResize={setDraft}
          onResizeEnd={(final) => {
            setResizing(false)
            setDraft(null)
            update({ x: final.x, y: final.y, w: final.width, h: final.height })
          }}
        />
      </section>
    </ToolsContextMenu>
  )
}
