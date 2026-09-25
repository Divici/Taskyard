import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AppTray,
  createAppTray,
  TRAY_TICK_MS,
  trayMenuTemplate,
  trayTooltip,
  type TrayActions,
  type TrayLike,
  type TrayMenuItem,
  type TrayState
} from './tray'

const STATE: TrayState = {
  quickHidden: false,
  toolsShown: true,
  autostart: true,
  timerText: null
}

function fakeActions(): TrayActions {
  return {
    toggleQuickHide: vi.fn(),
    togglePeek: vi.fn(),
    toggleTools: vi.fn(),
    openSettings: vi.fn(),
    refreshDesktop: vi.fn(),
    setAutostart: vi.fn(),
    quit: vi.fn()
  }
}

const labels = (items: TrayMenuItem[]): string[] =>
  items.map((item) => (item.type === 'separator' ? '---' : item.label!))

function item(items: TrayMenuItem[], label: string): TrayMenuItem {
  const found = items.find((entry) => entry.label === label)
  if (!found) throw new Error(`no tray item "${label}" in ${labels(items).join(', ')}`)
  return found
}

describe('trayMenuTemplate', () => {
  it('lists Show/Hide groups · Peek · Tools widget · Settings · Refresh desktop · Start with Windows · Quit', () => {
    expect(labels(trayMenuTemplate(STATE, fakeActions()))).toEqual([
      'Hide groups',
      'Peek',
      'Tools widget',
      '---',
      'Settings…',
      'Refresh desktop',
      'Start with Windows',
      '---',
      'Quit Taskyard'
    ])
  })

  it('says Show groups while the desktop is quick-hidden', () => {
    expect(labels(trayMenuTemplate({ ...STATE, quickHidden: true }, fakeActions()))[0]).toBe(
      'Show groups'
    )
  })

  it('ticks Tools widget and Start with Windows from the current state', () => {
    const on = trayMenuTemplate(STATE, fakeActions())
    expect(item(on, 'Tools widget')).toMatchObject({ type: 'checkbox', checked: true })
    expect(item(on, 'Start with Windows')).toMatchObject({ type: 'checkbox', checked: true })

    const off = trayMenuTemplate({ ...STATE, toolsShown: false, autostart: false }, fakeActions())
    expect(item(off, 'Tools widget').checked).toBe(false)
    expect(item(off, 'Start with Windows').checked).toBe(false)
  })

  it('each item runs its action', () => {
    const actions = fakeActions()
    const items = trayMenuTemplate(STATE, actions)

    item(items, 'Hide groups').click!()
    item(items, 'Peek').click!()
    item(items, 'Tools widget').click!()
    item(items, 'Settings…').click!()
    item(items, 'Refresh desktop').click!()
    item(items, 'Start with Windows').click!()
    item(items, 'Quit Taskyard').click!()

    expect(actions.toggleQuickHide).toHaveBeenCalledOnce()
    expect(actions.togglePeek).toHaveBeenCalledOnce()
    expect(actions.toggleTools).toHaveBeenCalledOnce()
    expect(actions.openSettings).toHaveBeenCalledOnce()
    expect(actions.refreshDesktop).toHaveBeenCalledOnce()
    // The box was ticked: clicking it turns Start with Windows off.
    expect(actions.setAutostart).toHaveBeenCalledExactlyOnceWith(false)
    expect(actions.quit).toHaveBeenCalledOnce()
  })
})

describe('trayTooltip', () => {
  it('is the app name, plus the timer while a countdown runs', () => {
    expect(trayTooltip(null)).toBe('Taskyard')
    expect(trayTooltip('Timer 12:34 left')).toBe('Taskyard · Timer 12:34 left')
  })
})

describe('createAppTray', () => {
  let tray: TrayLike & {
    setToolTip: ReturnType<typeof vi.fn>
    setContextMenu: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }
  let state: TrayState
  let actions: TrayActions
  let buildMenu: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    tray = { setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), destroy: vi.fn() }
    state = { ...STATE }
    actions = fakeActions()
    buildMenu = vi.fn((template: TrayMenuItem[]) => ({ template }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function start(): AppTray {
    return createAppTray({ createTray: () => tray, buildMenu, state: () => state, actions })
  }

  it('shows the menu and the tooltip at once', () => {
    start()
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Taskyard')
    expect(tray.setContextMenu).toHaveBeenCalledOnce()
    expect(labels(buildMenu.mock.calls[0][0])).toContain('Start with Windows')
  })

  it('a left click on the icon toggles Peek', () => {
    start()
    const [event, listener] = tray.on.mock.calls[0]
    expect(event).toBe('click')
    listener()
    expect(actions.togglePeek).toHaveBeenCalledOnce()
  })

  it('refresh rebuilds the menu from the current state', () => {
    const appTray = start()
    state = { ...state, quickHidden: true, autostart: false }
    appTray.refresh()
    const template = buildMenu.mock.calls.at(-1)![0] as TrayMenuItem[]
    expect(labels(template)[0]).toBe('Show groups')
    expect(item(template, 'Start with Windows').checked).toBe(false)
  })

  it('the tooltip counts down every second while the timer runs, then stops ticking', () => {
    const appTray = start()
    state = { ...state, timerText: 'Timer 00:03 left' }
    appTray.refresh()
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Taskyard · Timer 00:03 left')

    // The state is read again on every tick.
    state = { ...state, timerText: 'Timer 00:02 left' }
    vi.advanceTimersByTime(TRAY_TICK_MS)
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Taskyard · Timer 00:02 left')

    state = { ...STATE, timerText: null }
    vi.advanceTimersByTime(TRAY_TICK_MS)
    expect(tray.setToolTip).toHaveBeenLastCalledWith('Taskyard')
    const calls = tray.setToolTip.mock.calls.length
    vi.advanceTimersByTime(TRAY_TICK_MS * 5)
    expect(tray.setToolTip.mock.calls.length).toBe(calls)
    // The menu is not rebuilt on ticks (it would close an open menu).
    expect(tray.setContextMenu).toHaveBeenCalledTimes(2)
  })

  it('dispose removes the icon and stops ticking', () => {
    const appTray = start()
    state = { ...state, timerText: 'Timer 00:10 left' }
    appTray.refresh()
    appTray.dispose()
    expect(tray.destroy).toHaveBeenCalledOnce()
    const calls = tray.setToolTip.mock.calls.length
    vi.advanceTimersByTime(TRAY_TICK_MS * 3)
    expect(tray.setToolTip.mock.calls.length).toBe(calls)
    appTray.refresh()
    expect(tray.setToolTip.mock.calls.length).toBe(calls)
  })
})
