import { useEffect, useId, useRef, useState } from 'react'
import { FolderOpen, LayoutGrid, RotateCcw, X } from 'lucide-react'
import { RadioGroup } from 'radix-ui'
import type { AppInfo } from '@shared/ipc'
import type { Rect, SettingsFile } from '@shared/schema'
import { getBridge } from '../../lib/bridge'
import { confirmAutoOrganize, confirmResetLayout, openDataFolder } from '../../lib/canvas-actions'
import { MAX_BLUR_PX } from '../../lib/theme'
import { cn } from '../../lib/utils'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore, type SettingsPatch } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import { patchTools } from '../tools/tools-geometry'
import {
  InspectorButton,
  InspectorSection,
  SegmentedRadio,
  SettingSlider,
  SettingSwitch
} from './controls'
import { ShortcutRecorder } from './ShortcutRecorder'
import { WallpaperNote } from './WallpaperNote'

/** The panel's width (design/designInpo.html's inspector column). */
export const INSPECTOR_WIDTH = 320
/** Gap between the panel and the work area's edges. */
const INSET = 24

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' }
] as const satisfies readonly { value: SettingsFile['theme']; label: string }[]

const ICON_SIZES = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' }
] as const satisfies readonly { value: SettingsFile['iconSize']; label: string }[]

/** The design's four accent dots, in its order, with their swatch colours. */
const ACCENTS = [
  { value: 'blue', label: 'Blue', swatch: '#0077ff' },
  { value: 'cyan', label: 'Cyan', swatch: '#00f2ff' },
  { value: 'purple', label: 'Purple', swatch: '#8e2de2' },
  { value: 'white', label: 'White', swatch: '#ffffff' }
] as const satisfies readonly { value: SettingsFile['accent']; label: string; swatch: string }[]

export interface InspectorProps {
  displayId: number
  /** The work area in window coordinates: the panel runs down its right edge. */
  area: Rect
}

const update = (patch: SettingsPatch): void => useSettingsStore.getState().update(patch)
const close = (): void => useUiStore.getState().setInspectorOpen(false)

function AccentDots({ value }: { value: SettingsFile['accent'] }): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex items-center justify-between gap-3">
      <span id={id} className="text-[12px] text-text-primary/85">
        Accent colour
      </span>
      <RadioGroup.Root
        aria-labelledby={id}
        value={value}
        orientation="horizontal"
        onValueChange={(next) => update({ accent: next as SettingsFile['accent'] })}
        className="flex gap-2"
      >
        {ACCENTS.map((accent) => (
          <RadioGroup.Item
            key={accent.value}
            value={accent.value}
            aria-label={accent.label}
            title={accent.label}
            style={{ background: accent.swatch }}
            className={cn(
              'size-5 rounded-[6px] border-2 border-transparent transition-[border-color,box-shadow] outline-none',
              'data-[state=checked]:border-text-primary focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent',
              accent.value === 'white' && 'shadow-[inset_0_0_0_1px_rgb(0_0_0/0.15)]'
            )}
          />
        ))}
      </RadioGroup.Root>
    </div>
  )
}

function About(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const versions = getBridge().versions
  useEffect(() => {
    let live = true
    getBridge()
      .app.info()
      .then(
        (answer) => {
          if (live) setInfo(answer)
        },
        (error: unknown) => console.error('settings: asking main for the app info failed', error)
      )
    return () => {
      live = false
    }
  }, [])
  return (
    <InspectorSection title="About">
      <div className="flex flex-col gap-1 text-[11px] leading-relaxed text-text-tertiary">
        <p className="text-[12px] text-text-primary/85">
          <span className="font-semibold">{info?.name ?? 'Taskyard'}</span>
          {info && <span className="ml-1.5 text-text-tertiary">Version {info.version}</span>}
        </p>
        <p>A calm, glassy home for your desktop icons, tasks and focus timer.</p>
        <p>
          Electron {versions.electron} · Chromium {versions.chrome.split('.')[0]}
        </p>
        {info && (
          <p className="break-all" title={info.dataDir}>
            Data and logs: {info.dataDir}
          </p>
        )}
      </div>
    </InspectorSection>
  )
}

/**
 * The settings inspector (Assumption 11): a 320 px glass panel down the right of the work area,
 * after design/designInpo.html. Every control saves at once through the settings store, so the
 * change shows live on every display and is on disk 300 ms later. While it is open Taskyard is
 * Peeked and held above other apps; closing releases the hold.
 */
export function Inspector({ displayId, area }: InspectorProps): React.JSX.Element {
  const settings = useSettingsStore((state) => state.settings)
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)

  // Opening raises Taskyard over other apps and holds it there; closing lets the Peek end.
  useEffect(() => {
    const api = getBridge()
    const report = (error: unknown): void => console.error('settings: Peek hold failed', error)
    api.peek.hold(true).catch(report)
    return () => {
      api.peek.hold(false).catch(report)
    }
  }, [])

  // Focus moves into the panel, and back to where it was when the panel closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    panel.current?.focus()
    return () => {
      if (before?.isConnected) before.focus()
    }
  }, [])

  const setToolsEnabled = (on: boolean): void => {
    update({ toolsEnabled: on })
    if (!on) return
    // Turning the widget on must show it somewhere: here, when no display shows it.
    const shown = useLayoutStore.getState().layout.displays.some((display) => display.tools.visible)
    if (!shown) useLayoutStore.getState().updateTools(displayId, patchTools({ visible: true }))
  }

  const maxHeight = Math.max(area.height - INSET * 2, 200)

  return (
    <div
      ref={panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-inspector=""
      // Phase 9: clicks and typing here never end the Peek (lib/peek-sync.ts).
      data-peek-keep=""
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          close()
        }
      }}
      style={{
        width: INSPECTOR_WIDTH,
        maxHeight,
        left: area.x + area.width - INSPECTOR_WIDTH - INSET,
        top: area.y + INSET
      }}
      className="glass absolute z-[9500] flex flex-col overflow-hidden rounded-[32px] outline-none"
    >
      <header className="flex items-center justify-between gap-2 px-6 pt-5 pb-3">
        <h2 id={titleId} className="text-[15px] font-semibold tracking-tight">
          Settings
        </h2>
        <button
          type="button"
          aria-label="Close settings"
          onClick={close}
          className="flex size-7 items-center justify-center rounded-full text-text-secondary transition-colors outline-none hover:bg-text-primary/10 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent-1"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
        <InspectorSection title="Appearance">
          <SegmentedRadio
            label="Theme"
            value={settings.theme}
            options={THEMES}
            onChange={(theme) => update({ theme })}
          />
          <SettingSlider
            label="Glass opacity"
            value={settings.glassOpacity}
            min={0}
            max={100}
            unit="%"
            onChange={(glassOpacity) => update({ glassOpacity })}
          />
          <SettingSlider
            label="Glass blur"
            value={settings.glassBlur}
            min={0}
            max={MAX_BLUR_PX}
            unit=" px"
            onChange={(glassBlur) => update({ glassBlur })}
          />
          <SettingSwitch
            label="Emissive glow"
            description="A soft bloom around every glass panel."
            checked={settings.glow}
            onCheckedChange={(glow) => update({ glow })}
          />
          <AccentDots value={settings.accent} />
          <WallpaperNote />
        </InspectorSection>

        <InspectorSection title="Icons">
          <SegmentedRadio
            label="Icon size"
            value={settings.iconSize}
            options={ICON_SIZES}
            onChange={(iconSize) => update({ iconSize })}
          />
          <SettingSwitch
            label="Show file extensions"
            checked={settings.showExtensions}
            onCheckedChange={(showExtensions) => update({ showExtensions })}
          />
          <SettingSwitch
            label="Snap to grid"
            description="Groups and the tools widget move in 8 px steps."
            checked={settings.gridSnap}
            onCheckedChange={(gridSnap) => update({ gridSnap })}
          />
        </InspectorSection>

        <InspectorSection title="Behavior">
          <SettingSwitch
            label="Quick-hide on double-click"
            description="Double-click the empty desktop to hide or show everything."
            checked={settings.quickHideOnDoubleClick}
            onCheckedChange={(quickHideOnDoubleClick) => update({ quickHideOnDoubleClick })}
          />
          <ShortcutRecorder />
          <SettingSwitch
            label="Start with Windows"
            checked={settings.autostart}
            onCheckedChange={(autostart) => update({ autostart })}
          />
          <SettingSwitch
            label="Tools widget"
            description="Tasks and the focus timer on the desktop."
            checked={settings.toolsEnabled}
            onCheckedChange={setToolsEnabled}
          />
          <SettingSwitch
            label="Timer sound"
            checked={settings.timerSound}
            onCheckedChange={(timerSound) => update({ timerSound })}
          />
          <SettingSwitch
            label="Timer notification"
            description="A Windows notification when a countdown ends."
            checked={settings.timerNotify}
            onCheckedChange={(timerNotify) => update({ timerNotify })}
          />
          <SettingSwitch
            label="Reduce motion"
            description="No entrance or hover animations. Windows’ “Animation effects” off does the same."
            checked={settings.reduceMotion}
            onCheckedChange={(reduceMotion) => update({ reduceMotion })}
          />
        </InspectorSection>

        <InspectorSection title="Data">
          <div className="flex flex-col gap-1.5">
            <InspectorButton onClick={openDataFolder}>
              <FolderOpen aria-hidden="true" />
              Open data folder
            </InspectorButton>
            <InspectorButton
              onClick={() => void confirmAutoOrganize(displayId, area, settings.iconSize)}
            >
              <LayoutGrid aria-hidden="true" />
              Auto-organize now
            </InspectorButton>
            <InspectorButton
              tone="danger"
              onClick={() => void confirmResetLayout(settings.iconSize)}
            >
              <RotateCcw aria-hidden="true" />
              Reset layout…
            </InspectorButton>
          </div>
        </InspectorSection>

        <About />
      </div>
    </div>
  )
}
