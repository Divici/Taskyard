import { useId, useRef, useState } from 'react'
import { GROUP_HEADER_HEIGHT } from '@shared/group-metrics'
import type { Rect } from '@shared/schema'
import { openMenuFromKey } from '../../lib/context-menu-key'
import { cn } from '../../lib/utils'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { useTasksStore } from '../../stores/tasks'
import { GroupHeader } from '../group/GroupHeader'
import { ResizeHandles } from '../group/ResizeHandles'
import { useGroupDrag } from '../group/useGroupDrag'
import { headerClockFor } from './header-clock'
import { StopwatchHeaderClock, TimerHeaderClock } from './HeaderClock'
import { StopwatchTool } from './stopwatch/StopwatchTool'
import { TimerTool } from './timer/TimerTool'
import { TodoTool } from './todo/TodoTool'
import { ToolTabs } from './ToolTabs'
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

const TOOL_VIEWS: Readonly<Record<ToolId, () => React.JSX.Element>> = {
  tasks: TodoTool,
  timer: TimerTool,
  stopwatch: StopwatchTool
}

/**
 * The floating tools widget (Decision 6 + its 2026-09-23 extension): the group chrome — title
 * bar drag, 8 resize handles (min 280 × 220), roll-up, quick-hide — around the tab switcher at
 * the top (round 2: Tasks · Timer · Stopwatch, centred) and the active tool under it. Its rect,
 * roll-up and active tool are saved per display (layout `tools`); moves and resizes preview
 * locally and save once, on release. The header names the active tool and shows a clock per
 * `headerClockFor` (the countdown's time left, or rolled up on the Stopwatch tab the stopwatch).
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
  const stopwatch = useTasksStore((state) => state.stopwatch)
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
  const clock = headerClockFor(active, tools.rolledUp, timer, stopwatch)
  const ActiveTool = TOOL_VIEWS[active]

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
        // Shift+F10 / the menu key inside the widget: the tools menu (fields keep their own).
        onKeyDown={(event) => openMenuFromKey(event)}
        style={{
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: tools.rolledUp ? GROUP_HEADER_HEIGHT : rect.height,
          zIndex
        }}
        className={cn(
          // Transitions (hover lift, roll-up height): styles/motion.css, shared with the groups.
          'glass group-window absolute flex flex-col hover:border-accent-1/50',
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
          {clock === 'timer' && <TimerHeaderClock timer={timer} />}
          {clock === 'stopwatch' && <StopwatchHeaderClock stopwatch={stopwatch} />}
        </GroupHeader>
        {!tools.rolledUp && (
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-3 pt-2.5 pb-3">
            <ToolTabs
              active={active}
              onChange={(tool) => update({ activeTool: tool })}
              running={{
                timer: timer.status === 'running',
                stopwatch: stopwatch.status === 'running'
              }}
              idPrefix={idPrefix}
            />
            <div
              role="tabpanel"
              id={`${idPrefix}-panel`}
              aria-labelledby={`${idPrefix}-tab-${active}`}
              className="min-h-0 w-full min-w-0 flex-1"
            >
              <ActiveTool />
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
