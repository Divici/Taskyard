import { ImageOff } from 'lucide-react'
import type { WallpaperHint } from '@shared/ipc'
import { openSettingsPage } from '../../lib/canvas-actions'
import { useWallpaperStore } from '../../stores/wallpaper'

/** Windows Settings › Personalization › Background. */
const WALLPAPER_SETTINGS_URL = 'ms-settings:personalization-background'

/** What each wallpaper hint (Phase 6, `WallpaperInfo.hint`) means for the user. */
const WALLPAPER_HINTS: Readonly<Record<WallpaperHint, string>> = {
  'solid-color': 'Windows shows a solid colour on this display, so Taskyard does too.',
  transcoded:
    'Taskyard can’t show your wallpaper file directly (an HDR .jxr picture, for example), so it shows the copy Windows made of it.',
  'color-fallback':
    'Taskyard can’t show your wallpaper file (an HDR .jxr picture, for example) and Windows has no copy of it, so it shows the desktop colour. A JPEG or PNG wallpaper fixes this.',
  unavailable:
    'Taskyard couldn’t read your Windows wallpaper, so it shows the desktop colour instead.'
}

/** Appearance › the wallpaper hint for this display, or nothing when the wallpaper is fine. */
export function WallpaperNote(): React.JSX.Element | null {
  const hint = useWallpaperStore((state) => state.info?.hint ?? null)
  if (hint === null) return null
  return (
    <div
      role="note"
      aria-label="Wallpaper"
      className="flex gap-2.5 rounded-[10px] bg-text-primary/5 p-2.5 text-[11px] leading-snug text-text-secondary"
    >
      <ImageOff aria-hidden="true" className="mt-px size-3.5 shrink-0 text-accent-1" />
      <div className="flex flex-col items-start gap-1.5">
        <p>{WALLPAPER_HINTS[hint]}</p>
        <button
          type="button"
          onClick={() => openSettingsPage(WALLPAPER_SETTINGS_URL)}
          className="rounded-[6px] text-[11px] font-medium text-accent-1 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-1"
        >
          Open wallpaper settings
        </button>
      </div>
    </div>
  )
}
