import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/defaults'
import type { ThemeInfo } from '@shared/ipc'
import type { SettingsFile } from '@shared/schema'
import { createFakeBridge } from '../test/fake-bridge'
import { useSettingsStore } from '../stores/settings'
import { applyTheme, connectTheme, MAX_BLUR_PX, resolveTheme, themeAttributes } from './theme'

const DARK_OS: ThemeInfo = { shouldUseDarkColors: true, prefersReducedTransparency: false }
const LIGHT_OS: ThemeInfo = { shouldUseDarkColors: false, prefersReducedTransparency: false }

function loadSettings(patch: Partial<SettingsFile>, revision = 1): void {
  useSettingsStore.getState().receive({ revision, data: { ...defaultSettings(), ...patch } })
}

/** Lets the bridge's theme.get promise settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  const root = document.documentElement
  root.removeAttribute('data-theme')
  root.removeAttribute('data-reduced-transparency')
  root.removeAttribute('data-accent')
  root.removeAttribute('data-glow')
  root.removeAttribute('style')
  root.classList.remove('reduce-motion')
})

describe('resolveTheme', () => {
  it('system follows the Windows app theme', () => {
    expect(resolveTheme('system', DARK_OS)).toBe('dark')
    expect(resolveTheme('system', LIGHT_OS)).toBe('light')
  })

  it('a dark or light override wins over Windows', () => {
    expect(resolveTheme('light', DARK_OS)).toBe('light')
    expect(resolveTheme('dark', LIGHT_OS)).toBe('dark')
  })

  it('before main has answered, system falls back to the given default', () => {
    expect(resolveTheme('system', null)).toBe('dark')
    expect(resolveTheme('system', null, false)).toBe('light')
  })
})

describe('themeAttributes / applyTheme', () => {
  it('writes data-theme, the blur and the glass opacity from settings', () => {
    const root = document.createElement('div')
    applyTheme(root, themeAttributes(defaultSettings(), DARK_OS))
    expect(root.dataset.theme).toBe('dark')
    expect(root.style.getPropertyValue('--blur')).toBe('16px')
    expect(root.style.getPropertyValue('--glass-opacity')).toBe('0.4')
    expect(root.style.colorScheme).toBe('dark')
    expect(root.hasAttribute('data-reduced-transparency')).toBe(false)
  })

  it(`caps the blur at ${MAX_BLUR_PX} px (many blurred groups must hold 60 fps)`, () => {
    const attrs = themeAttributes({ ...defaultSettings(), glassBlur: 40 }, DARK_OS)
    expect(attrs.blurPx).toBe(MAX_BLUR_PX)
  })

  it('Phase 11: writes the accent colour and the glow switch', () => {
    const root = document.createElement('div')
    applyTheme(root, themeAttributes(defaultSettings(), DARK_OS))
    expect(root.dataset.accent).toBe('cyan')
    expect(root.dataset.glow).toBe('on')

    applyTheme(
      root,
      themeAttributes({ ...defaultSettings(), accent: 'purple', glow: false }, DARK_OS)
    )
    expect(root.dataset.accent).toBe('purple')
    expect(root.dataset.glow).toBe('off')
  })

  it('Phase 12: the reduce-motion kill switch puts the reduce-motion class on the root', () => {
    const root = document.createElement('div')
    applyTheme(root, themeAttributes(defaultSettings(), DARK_OS))
    expect(root.classList.contains('reduce-motion')).toBe(false)

    applyTheme(root, themeAttributes({ ...defaultSettings(), reduceMotion: true }, DARK_OS))
    expect(root.classList.contains('reduce-motion')).toBe(true)

    applyTheme(root, themeAttributes(defaultSettings(), DARK_OS))
    expect(root.classList.contains('reduce-motion')).toBe(false)
  })

  it('sets data-reduced-transparency when Windows has transparency effects off', () => {
    const root = document.createElement('div')
    applyTheme(
      root,
      themeAttributes(defaultSettings(), { ...LIGHT_OS, prefersReducedTransparency: true })
    )
    expect(root.getAttribute('data-reduced-transparency')).toBe('')
    applyTheme(root, themeAttributes(defaultSettings(), LIGHT_OS))
    expect(root.hasAttribute('data-reduced-transparency')).toBe(false)
  })
})

describe('connectTheme', () => {
  it('system → dark from main, then flips live with the Windows app theme', async () => {
    const bridge = createFakeBridge()
    bridge.theme.get.mockResolvedValue(DARK_OS)
    loadSettings({ theme: 'system' })
    const disconnect = connectTheme(bridge)
    await settle()
    expect(document.documentElement.dataset.theme).toBe('dark')

    bridge.emit('theme:changed', LIGHT_OS)
    expect(document.documentElement.dataset.theme).toBe('light')
    disconnect()
  })

  it('the override wins, and changing the setting re-applies at once', async () => {
    const bridge = createFakeBridge()
    bridge.theme.get.mockResolvedValue(DARK_OS)
    loadSettings({ theme: 'light' })
    const disconnect = connectTheme(bridge)
    await settle()
    expect(document.documentElement.dataset.theme).toBe('light')

    // Windows flips; the override still wins.
    bridge.emit('theme:changed', LIGHT_OS)
    bridge.emit('theme:changed', DARK_OS)
    expect(document.documentElement.dataset.theme).toBe('light')

    loadSettings({ theme: 'system' }, 2)
    expect(document.documentElement.dataset.theme).toBe('dark')
    loadSettings({ theme: 'system', glassBlur: 8 }, 3)
    expect(document.documentElement.style.getPropertyValue('--blur')).toBe('8px')
    loadSettings({ theme: 'system', accent: 'white', glow: false }, 4)
    expect(document.documentElement.dataset.accent).toBe('white')
    expect(document.documentElement.dataset.glow).toBe('off')
    disconnect()
  })

  it('mirrors reduced transparency on the root element', async () => {
    const bridge = createFakeBridge()
    bridge.theme.get.mockResolvedValue({ ...DARK_OS, prefersReducedTransparency: true })
    const disconnect = connectTheme(bridge)
    await settle()
    expect(document.documentElement.hasAttribute('data-reduced-transparency')).toBe(true)

    bridge.emit('theme:changed', DARK_OS)
    expect(document.documentElement.hasAttribute('data-reduced-transparency')).toBe(false)
    disconnect()
  })

  it('an event that arrives before the initial answer is not overwritten by it', async () => {
    const bridge = createFakeBridge()
    let answer: (info: ThemeInfo) => void = () => {}
    bridge.theme.get.mockReturnValue(new Promise((resolve) => (answer = resolve)))
    const disconnect = connectTheme(bridge)
    bridge.emit('theme:changed', LIGHT_OS)
    answer(DARK_OS)
    await settle()
    expect(document.documentElement.dataset.theme).toBe('light')
    disconnect()
  })

  it('stops following main and the settings after disconnect', async () => {
    const bridge = createFakeBridge()
    bridge.theme.get.mockResolvedValue(DARK_OS)
    const disconnect = connectTheme(bridge)
    await settle()
    disconnect()
    expect(bridge.listenerCount('theme:changed')).toBe(0)
    bridge.emit('theme:changed', LIGHT_OS)
    loadSettings({ theme: 'light' }, 5)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('keeps the default dark theme when asking main fails (logged)', async () => {
    const bridge = createFakeBridge()
    bridge.theme.get.mockRejectedValue(new Error('no main'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const disconnect = connectTheme(bridge)
    await settle()
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(error).toHaveBeenCalledWith(
      'theme: asking main for the Windows theme failed',
      expect.any(Error)
    )
    disconnect()
  })
})
