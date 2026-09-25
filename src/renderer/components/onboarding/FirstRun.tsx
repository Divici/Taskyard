import { useEffect, useId, useRef } from 'react'
import { Eye, LayoutGrid, MousePointerClick } from 'lucide-react'
import type { Rect } from '@shared/schema'
import { autoOrganizeDisplay } from '../../lib/canvas-actions'
import { useItemsStore } from '../../stores/items'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { Switch } from '../ui/switch'

export interface FirstRunProps {
  displayId: number
  /** The work area (window coordinates): the card sits in its middle. */
  area: Rect
}

const WIDTH = 440

/** How many of this display's loose icons are on the desktop now (Auto-organize's reach). */
function useLooseCount(displayId: number): number {
  const loose = useLayoutStore(
    (state) => state.layout.displays.find((display) => display.displayId === displayId)?.loose
  )
  const byId = useItemsStore((state) => state.byId)
  return Object.keys(loose ?? {}).filter((id) => byId[id] !== undefined).length
}

const finish = (): void => useSettingsStore.getState().update({ firstRunDone: true })

/**
 * First-run onboarding (Assumption 16), once, on the primary display: what Taskyard is, the Peek
 * shortcut, and a choice — group the icons by type now (Auto-organize) or keep the desktop as it
 * is. Either choice (or Get started) sets `firstRunDone`. Start with Windows can be switched off
 * right here, since it is on by default (Assumption 12).
 */
export function FirstRun({ displayId, area }: FirstRunProps): React.JSX.Element {
  const shortcut = useSettingsStore((state) => state.settings.peekShortcut)
  const autostart = useSettingsStore((state) => state.settings.autostart)
  const iconSize = useSettingsStore((state) => state.settings.iconSize)
  const count = useLooseCount(displayId)
  const titleId = useId()
  const primary = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    primary.current?.focus()
  }, [])

  const organize = (): void => {
    autoOrganizeDisplay(displayId, area, iconSize)
    finish()
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-first-run=""
      // Phase 9: clicks here never end a Peek (lib/peek-sync.ts).
      data-peek-keep=""
      className="glass absolute z-[9400] flex flex-col gap-5 rounded-[32px] p-7"
      style={{
        width: WIDTH,
        left: area.x + area.width / 2 - WIDTH / 2,
        top: area.y + area.height / 2,
        transform: 'translateY(-50%)'
      }}
    >
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] font-semibold tracking-[0.14em] text-accent-1 uppercase">
          First run
        </p>
        <h2 id={titleId} className="text-[20px] font-semibold tracking-tight">
          Welcome to Taskyard
        </h2>
        <p className="text-[13px] leading-relaxed text-text-secondary">
          Your desktop icons now live on glass. Nothing moved: every file stays where it was, and
          Taskyard only remembers where each icon sits.
        </p>
      </div>

      <ul className="flex flex-col gap-3 text-[12px] leading-snug text-text-secondary">
        <li className="flex gap-3">
          <MousePointerClick aria-hidden="true" className="mt-px size-4 shrink-0 text-accent-1" />
          <span>
            Right-click the desktop for <span className="text-text-primary">New group here</span>,
            or drag with the right mouse button to draw one around icons.
          </span>
        </li>
        <li className="flex gap-3">
          <Eye aria-hidden="true" className="mt-px size-4 shrink-0 text-accent-1" />
          <span>
            Press <span className="font-medium text-text-primary">{shortcut}</span> to Peek at your
            desktop over any app. Double-click empty space to hide everything.
          </span>
        </li>
      </ul>

      <div className="flex items-center justify-between gap-3 rounded-[14px] bg-text-primary/5 px-4 py-3">
        <label htmlFor={`${titleId}-autostart`} className="text-[12px] text-text-primary/85">
          Start with Windows
        </label>
        <Switch
          id={`${titleId}-autostart`}
          checked={autostart}
          onCheckedChange={(on) => useSettingsStore.getState().update({ autostart: on })}
        />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        {count > 0 ? (
          <>
            <button
              type="button"
              onClick={finish}
              className="rounded-[10px] px-3.5 py-2 text-[13px] text-text-secondary transition-colors outline-none hover:bg-text-primary/10 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent-1"
            >
              Keep my desktop as it is
            </button>
            <button
              ref={primary}
              type="button"
              onClick={organize}
              className="flex items-center gap-2 rounded-[10px] bg-gradient-to-r from-accent-2 to-accent-1 px-3.5 py-2 text-[13px] font-semibold text-black shadow-[0_4px_16px_color-mix(in_srgb,var(--accent-2)_35%,transparent)] transition-[filter] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-text-primary"
            >
              <LayoutGrid aria-hidden="true" className="size-4" />
              Organize {count} icon{count === 1 ? '' : 's'} by type
            </button>
          </>
        ) : (
          <button
            ref={primary}
            type="button"
            onClick={finish}
            className="rounded-[10px] bg-gradient-to-r from-accent-2 to-accent-1 px-3.5 py-2 text-[13px] font-semibold text-black transition-[filter] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-text-primary"
          >
            Get started
          </button>
        )}
      </div>
    </div>
  )
}
