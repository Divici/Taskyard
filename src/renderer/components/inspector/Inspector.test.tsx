import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import type { SettingsFile } from '@shared/schema'
import { useLayoutStore } from '../../stores/layout'
import { useSettingsStore } from '../../stores/settings'
import { useUiStore } from '../../stores/ui'
import { useWallpaperStore } from '../../stores/wallpaper'
import { desktopItem, makeGroup, PRIMARY_INFO, seedCanvas } from '../../test/canvas-fixtures'
import { FAKE_WALLPAPER, installFakeBridge, type FakeBridge } from '../../test/fake-bridge'
import { Inspector } from './Inspector'

const AREA = { x: 0, y: 0, width: 2560, height: 1392 }

interface Setup extends ReturnType<typeof render> {
  bridge: FakeBridge
  panel: HTMLElement
  user: ReturnType<typeof userEvent.setup>
}

function setup(
  settings: Partial<SettingsFile> = {},
  seed: Parameters<typeof seedCanvas>[0] = {}
): Setup {
  const bridge = installFakeBridge()
  seedCanvas({ ...seed, settings })
  act(() => useUiStore.getState().setInspectorOpen(true))
  const view = render(<Inspector displayId={PRIMARY_INFO.id} area={AREA} />)
  const panel = screen.getByRole('dialog', { name: 'Settings' })
  return { bridge, panel, user: userEvent.setup(), ...view }
}

const current = (): SettingsFile => useSettingsStore.getState().settings

/** The last settings file the inspector saved through the bridge. */
function lastSavedSettings(bridge: FakeBridge): SettingsFile | undefined {
  const call = bridge.storage.save.mock.calls.filter(([store]) => store === 'settings').at(-1)
  return call?.[1].data as SettingsFile | undefined
}

describe('Inspector', () => {
  it('is a 320 px glass panel on the right with the four sections and About', async () => {
    const { panel, container } = setup()

    expect(panel).toHaveClass('glass')
    expect(panel).toHaveStyle({ width: '320px' })
    expect(panel).toHaveAttribute('data-peek-keep')
    for (const name of ['Appearance', 'Icons', 'Behavior', 'Data', 'About']) {
      expect(within(panel).getByRole('heading', { name })).toBeVisible()
    }
    await waitFor(() => expect(within(panel).getByText('Version 0.1.0')).toBeVisible())
    expect(await axe(container)).toHaveNoViolations()
  })

  it('opening it holds a Peek; closing releases the hold', async () => {
    const { bridge, unmount } = setup()
    expect(bridge.peek.hold).toHaveBeenCalledExactlyOnceWith(true)
    unmount()
    expect(bridge.peek.hold).toHaveBeenLastCalledWith(false)
  })

  it('Esc and the close button close it', async () => {
    const { panel, user } = setup()
    await user.click(within(panel).getByRole('button', { name: 'Close settings' }))
    expect(useUiStore.getState().inspectorOpen).toBe(false)

    act(() => useUiStore.getState().setInspectorOpen(true))
    within(panel).getByRole('radio', { name: 'Dark' }).focus()
    await user.keyboard('{Escape}')
    expect(useUiStore.getState().inspectorOpen).toBe(false)
  })

  describe('Appearance', () => {
    it('a slider shows its value and saves the setting as it moves', async () => {
      const { bridge, panel, user } = setup()
      const opacity = within(panel).getByRole('slider', { name: 'Glass opacity' })
      expect(within(panel).getByText('40%')).toBeVisible()

      act(() => opacity.focus())
      await user.keyboard('{ArrowRight}{ArrowRight}')

      expect(current().glassOpacity).toBe(42)
      expect(within(panel).getByText('42%')).toBeVisible()
      expect(opacity).toHaveAttribute('aria-valuetext', '42%')
      await waitFor(() => expect(lastSavedSettings(bridge)?.glassOpacity).toBe(42))
    })

    it('the blur slider runs 0–20 px and shows a stored value above 20 as 20 px', async () => {
      const { panel, user } = setup({ glassBlur: 34 })
      const blur = within(panel).getByRole('slider', { name: 'Glass blur' })
      expect(blur).toHaveAttribute('aria-valuemax', '20')
      expect(blur).toHaveAttribute('aria-valuenow', '20')
      expect(within(panel).getByText('20 px')).toBeVisible()

      act(() => blur.focus())
      await user.keyboard('{ArrowLeft}')
      expect(current().glassBlur).toBe(19)
    })

    it('theme radio: System, Dark, Light', async () => {
      const { bridge, panel, user } = setup()
      const theme = within(panel).getByRole('radiogroup', { name: 'Theme' })
      expect(within(theme).getByRole('radio', { name: 'System' })).toBeChecked()

      await user.click(within(theme).getByRole('radio', { name: 'Light' }))

      expect(current().theme).toBe('light')
      expect(within(theme).getByRole('radio', { name: 'Light' })).toBeChecked()
      await waitFor(() => expect(lastSavedSettings(bridge)?.theme).toBe('light'))
    })

    it('accent dots pick the accent colour, and the glow toggle switches the bloom', async () => {
      const { panel, user } = setup()
      const accent = within(panel).getByRole('radiogroup', { name: 'Accent colour' })
      expect(within(accent).getByRole('radio', { name: 'Cyan' })).toBeChecked()
      await user.click(within(accent).getByRole('radio', { name: 'Purple' }))
      expect(current().accent).toBe('purple')

      const glow = within(panel).getByRole('switch', { name: 'Emissive glow' })
      expect(glow).toBeChecked()
      await user.click(glow)
      expect(current().glow).toBe(false)
    })

    it('explains a wallpaper Taskyard cannot show, with a way to fix it', async () => {
      useWallpaperStore.getState().setInfo({ ...FAKE_WALLPAPER, hint: 'color-fallback' })
      const { bridge, panel, user } = setup()

      const hint = within(panel).getByRole('note', { name: 'Wallpaper' })
      expect(hint).toHaveTextContent('can’t show your wallpaper')
      await user.click(within(hint).getByRole('button', { name: 'Open wallpaper settings' }))
      expect(bridge.app.openExternal).toHaveBeenCalledWith('ms-settings:personalization-background')
    })

    it('shows no wallpaper note when the wallpaper is fine', () => {
      useWallpaperStore.getState().setInfo({ ...FAKE_WALLPAPER, hint: null })
      const { panel } = setup()
      expect(within(panel).queryByRole('note', { name: 'Wallpaper' })).toBeNull()
    })
  })

  describe('Icons and Behavior toggles', () => {
    it('icon size is a radio group', async () => {
      const { panel, user } = setup()
      await user.click(within(panel).getByRole('radio', { name: 'Large' }))
      expect(current().iconSize).toBe('large')
    })

    it('round 2: the grid step is a radio group (8 / 16 / 32 px), shown while snapping is on', async () => {
      const { bridge, panel, user } = setup()
      const step = within(panel).getByRole('radiogroup', { name: 'Grid size' })
      expect(within(step).getByRole('radio', { name: '16 px' })).toBeChecked()

      await user.click(within(step).getByRole('radio', { name: '32 px' }))
      expect(current().gridSize).toBe(32)
      await waitFor(() => expect(lastSavedSettings(bridge)?.gridSize).toBe(32))
      await user.click(within(step).getByRole('radio', { name: '8 px' }))
      expect(current().gridSize).toBe(8)

      await user.click(within(panel).getByRole('switch', { name: 'Snap to grid' }))
      expect(within(panel).queryByRole('radiogroup', { name: 'Grid size' })).toBeNull()
    })

    it.each([
      ['Show file extensions', 'showExtensions', false],
      ['Snap to grid', 'gridSnap', true],
      ['Quick-hide on double-click', 'quickHideOnDoubleClick', true],
      ['Start with Windows', 'autostart', true],
      ['Tools widget', 'toolsEnabled', true],
      ['Timer sound', 'timerSound', true],
      ['Timer notification', 'timerNotify', true],
      ['Reduce motion', 'reduceMotion', false]
    ] as const)('%s switches settings.%s', async (label, field, initial) => {
      const { bridge, panel, user } = setup()
      const toggle = within(panel).getByRole('switch', { name: label })
      if (initial) expect(toggle).toBeChecked()
      else expect(toggle).not.toBeChecked()

      await user.click(toggle)

      expect(current()[field]).toBe(!initial)
      await waitFor(() => expect(lastSavedSettings(bridge)?.[field]).toBe(!initial))
    })
  })

  describe('Peek shortcut recorder', () => {
    async function record(
      user: ReturnType<typeof userEvent.setup>,
      panel: HTMLElement,
      keys: string
    ): Promise<void> {
      await user.click(within(panel).getByRole('button', { name: /Peek shortcut/ }))
      await user.keyboard(keys)
    }

    it('rejects a shortcut Windows would not allow as global, keeping the old one', async () => {
      const { bridge, panel, user } = setup()
      await record(user, panel, '{Shift>}a{/Shift}')

      expect(within(panel).getByRole('alert')).toHaveTextContent(
        '“Shift+A” can’t be a shortcut. Use Ctrl, Alt or Win with a key, or a function key.'
      )
      expect(current().peekShortcut).toBe('Ctrl+Alt+Space')
      expect(lastSavedSettings(bridge)).toBeUndefined()
      expect(within(panel).getByRole('button', { name: /Peek shortcut/ })).toHaveTextContent(
        'Ctrl+Alt+Space'
      )
    })

    it('Esc cancels recording without changing anything', async () => {
      const { panel, user } = setup()
      await record(user, panel, '{Escape}')
      expect(within(panel).getByRole('button', { name: /Peek shortcut/ })).toHaveTextContent(
        'Ctrl+Alt+Space'
      )
      expect(within(panel).queryByRole('alert')).toBeNull()
      expect(useUiStore.getState().inspectorOpen).toBe(true)
    })

    it('saves a valid shortcut and confirms once main has registered it', async () => {
      const { bridge, panel, user } = setup()
      await record(user, panel, '{Control>}{Alt>}k{/Alt}{/Control}')

      expect(current().peekShortcut).toBe('Ctrl+Alt+K')
      act(() =>
        bridge.emit('peek:shortcut', {
          accelerator: 'Ctrl+Alt+K',
          active: 'Ctrl+Alt+K',
          error: null
        })
      )
      expect(within(panel).getByRole('status', { name: 'Peek shortcut status' })).toHaveTextContent(
        'Peek now opens with Ctrl+Alt+K.'
      )
    })

    it('a shortcut another app owns shows an inline error and keeps the previous binding', async () => {
      const { bridge, panel, user } = setup({ peekShortcut: 'Ctrl+Alt+Shift+Space' })
      await record(user, panel, '{Control>}{Alt>}j{/Alt}{/Control}')
      expect(current().peekShortcut).toBe('Ctrl+Alt+J')

      act(() =>
        bridge.emit('peek:shortcut', {
          accelerator: 'Ctrl+Alt+J',
          active: 'Ctrl+Alt+Shift+Space',
          error: 'in-use'
        })
      )

      expect(within(panel).getByRole('alert')).toHaveTextContent(
        'Ctrl+Alt+J is already used by another app. Peek keeps Ctrl+Alt+Shift+Space.'
      )
      expect(current().peekShortcut).toBe('Ctrl+Alt+Shift+Space')
      await waitFor(() =>
        expect(lastSavedSettings(bridge)?.peekShortcut).toBe('Ctrl+Alt+Shift+Space')
      )
    })

    it('says so when the saved shortcut could not be registered (how users fix a taken default)', async () => {
      const bridge = installFakeBridge()
      bridge.peek.shortcutStatus.mockResolvedValue({
        accelerator: 'Ctrl+Alt+Space',
        active: null,
        error: 'in-use'
      })
      seedCanvas()
      render(<Inspector displayId={PRIMARY_INFO.id} area={AREA} />)
      const panel = screen.getByRole('dialog', { name: 'Settings' })

      await waitFor(() =>
        expect(within(panel).getByRole('alert')).toHaveTextContent(
          'Ctrl+Alt+Space is used by another app, so Peek has no shortcut. Choose another.'
        )
      )
    })
  })

  describe('Data', () => {
    it('opens the data folder', async () => {
      const { bridge, panel, user } = setup()
      await user.click(within(panel).getByRole('button', { name: 'Open data folder' }))
      expect(bridge.app.openDataFolder).toHaveBeenCalledOnce()
    })

    it('Auto-organize now asks first, then groups this display’s loose icons', async () => {
      const items = [
        desktopItem('1:1', 'Notes'),
        desktopItem('1:2', 'Tool', { kind: 'app', ext: '.exe' })
      ]
      const { panel, user } = setup(
        {},
        { items, loose: { '1:1': { x: 0, y: 0 }, '1:2': { x: 0, y: 96 } } }
      )

      await user.click(within(panel).getByRole('button', { name: 'Auto-organize now' }))
      expect(useUiStore.getState().confirmRequest?.title).toBe('Auto-organize this desktop?')
      act(() => useUiStore.getState().resolveConfirm(true))

      await waitFor(() =>
        expect(useLayoutStore.getState().layout.displays[0].groups.map((g) => g.title)).toEqual([
          'Apps',
          'Files'
        ])
      )
    })

    it('Reset layout asks (destructive), then clears the groups and lays the icons out again', async () => {
      const items = [desktopItem('1:1', 'Notes'), desktopItem('1:2', 'Plan')]
      const { bridge, panel, user } = setup(
        {},
        {
          items,
          groups: [makeGroup('g', { items: ['1:1'] })],
          loose: { '1:2': { x: 900, y: 500 } }
        }
      )

      await user.click(within(panel).getByRole('button', { name: 'Reset layout…' }))
      const request = useUiStore.getState().confirmRequest
      expect(request).toMatchObject({ title: 'Reset the layout?', destructive: true })
      act(() => useUiStore.getState().resolveConfirm(true))

      await waitFor(() => expect(useLayoutStore.getState().layout.displays[0].groups).toEqual([]))
      expect(bridge.display.list).toHaveBeenCalled()
      expect(Object.keys(useLayoutStore.getState().layout.displays[0].loose).sort()).toEqual([
        '1:1',
        '1:2'
      ])
      expect(useLayoutStore.getState().layout.displays[0].loose['1:1']).toEqual({ x: 0, y: 0 })
    })

    it('Reset layout does nothing when cancelled', async () => {
      const { panel, user } = setup({}, { groups: [makeGroup('g')] })
      await user.click(within(panel).getByRole('button', { name: 'Reset layout…' }))
      act(() => useUiStore.getState().resolveConfirm(false))
      await Promise.resolve()
      expect(useLayoutStore.getState().layout.displays[0].groups).toHaveLength(1)
    })
  })
})
