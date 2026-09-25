import type { StoreApi } from 'zustand'
import type { ThemeInfo } from '@shared/ipc'
import type { SettingsFile } from '@shared/schema'
import type { TaskyardApi } from '../../preload/api'
import { useSettingsStore, type SettingsState } from '../stores/settings'

// The theme contract every later layer styles against (tokens.css, glass.css):
// - `data-theme="dark" | "light"` on <html>: the Settings choice, or the Windows app theme for
//   "system".
// - `data-reduced-transparency` on <html> (present/absent): Windows' "Transparency effects" is off
//   (`nativeTheme.prefersReducedTransparency`); glass turns opaque and unblurred.
// - `--blur` and `--glass-opacity` on <html>: Settings › glass blur (px, capped) and opacity (0–1).
// - Phase 11: `data-accent="cyan" | "blue" | "purple" | "white"` (tokens.css re-tints
//   --accent-1/--accent-2 per theme) and `data-glow="on" | "off"` (off drops the outer bloom).

/**
 * Blur radius cap. `backdrop-filter` cost grows with the radius and with every group on screen;
 * 20 px keeps many groups at 60 fps (plan Risks: "blur ≤ 20 px"). Settings allow up to 40.
 */
export const MAX_BLUR_PX = 20

export type ThemeSetting = SettingsFile['theme']
export type ResolvedTheme = 'dark' | 'light'

export interface ThemeAttributes {
  theme: ResolvedTheme
  reducedTransparency: boolean
  blurPx: number
  /** 0–1. */
  glassOpacity: number
  accent: SettingsFile['accent']
  glow: boolean
}

/** The settings the root attributes are built from. */
export type ThemeSettings = Pick<
  SettingsFile,
  'theme' | 'glassBlur' | 'glassOpacity' | 'accent' | 'glow'
>

/** Chromium's own view of the OS theme, before main has answered (dark when unknown). */
function prefersDark(): boolean {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
  } catch {
    return true
  }
}

/** `dark`/`light` win; `system` follows Windows (or `fallbackDark` until main has said). */
export function resolveTheme(
  setting: ThemeSetting,
  system: ThemeInfo | null,
  fallbackDark = true
): ResolvedTheme {
  if (setting !== 'system') return setting
  const dark = system === null ? fallbackDark : system.shouldUseDarkColors
  return dark ? 'dark' : 'light'
}

export function themeAttributes(
  settings: ThemeSettings,
  system: ThemeInfo | null,
  fallbackDark = true
): ThemeAttributes {
  return {
    theme: resolveTheme(settings.theme, system, fallbackDark),
    reducedTransparency: system?.prefersReducedTransparency ?? false,
    blurPx: Math.min(Math.max(settings.glassBlur, 0), MAX_BLUR_PX),
    glassOpacity: Math.min(Math.max(settings.glassOpacity, 0), 100) / 100,
    accent: settings.accent,
    glow: settings.glow
  }
}

export function applyTheme(root: HTMLElement, attrs: ThemeAttributes): void {
  root.dataset.theme = attrs.theme
  root.toggleAttribute('data-reduced-transparency', attrs.reducedTransparency)
  root.style.setProperty('--blur', `${attrs.blurPx}px`)
  root.style.setProperty('--glass-opacity', String(attrs.glassOpacity))
  root.dataset.accent = attrs.accent
  root.dataset.glow = attrs.glow ? 'on' : 'off'
  // Native form controls and scrollbars follow the resolved theme too.
  root.style.colorScheme = attrs.theme
}

/** Before React renders: the defaults with Chromium's own OS-theme guess, so nothing flashes. */
export function applyInitialTheme(root: HTMLElement, settings: ThemeSettings): void {
  applyTheme(root, themeAttributes(settings, null, prefersDark()))
}

export interface ConnectThemeOptions {
  root?: HTMLElement
  settings?: Pick<StoreApi<SettingsState>, 'getState' | 'subscribe'>
}

/**
 * Keeps <html>'s theme attributes in step with the settings store and with Windows: asks main
 * for the Windows theme once (`theme:get`), follows `theme:changed` live, and re-applies on every
 * settings change. Returns the disconnect.
 */
export function connectTheme(
  api: Pick<TaskyardApi, 'theme' | 'on'>,
  { root = document.documentElement, settings = useSettingsStore }: ConnectThemeOptions = {}
): () => void {
  let system: ThemeInfo | null = null
  let connected = true
  const fallbackDark = prefersDark()

  const apply = (): void => {
    applyTheme(root, themeAttributes(settings.getState().settings, system, fallbackDark))
  }

  const unsubscribeEvents = api.on('theme:changed', (info) => {
    system = { ...info }
    apply()
  })
  const unsubscribeSettings = settings.subscribe((state, previous) => {
    if (state.settings !== previous.settings) apply()
  })
  apply()

  api.theme.get().then(
    (info) => {
      // An event that arrived meanwhile is at least as new as this answer.
      if (!connected || system !== null) return
      system = { ...info }
      apply()
    },
    (error: unknown) => {
      if (connected) console.error('theme: asking main for the Windows theme failed', error)
    }
  )

  return () => {
    connected = false
    unsubscribeEvents()
    unsubscribeSettings()
  }
}
