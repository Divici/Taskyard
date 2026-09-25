import { APP_NAME } from '@shared/app-info'

// The notification-area icon (Assumption 12: Taskyard runs from the tray, with no taskbar
// button). Menu: Show/Hide groups · Peek · Tools widget ✓ · Settings · Refresh desktop · Start
// with Windows ✓ · Quit. The tooltip shows the countdown's time left while the timer runs.
// Electron's Tray and Menu are injected, so this module is tested without Electron.

/** What the menu shows; read fresh on every refresh and tick. */
export interface TrayState {
  /** Quick-hide is on (every display): the item offers "Show groups". */
  quickHidden: boolean
  /** The tools widget shows on some display. */
  toolsShown: boolean
  /** Settings › Start with Windows. */
  autostart: boolean
  /** `timerStatusText` (tools-control.ts), or null when no countdown is in progress. */
  timerText: string | null
}

export interface TrayActions {
  toggleQuickHide(): void
  togglePeek(): void
  toggleTools(): void
  openSettings(): void
  refreshDesktop(): void
  setAutostart(on: boolean): void
  quit(): void
}

/** A menu item as Electron's `Menu.buildFromTemplate` takes it (the fields used here). */
export interface TrayMenuItem {
  label?: string
  type?: 'normal' | 'checkbox' | 'separator'
  checked?: boolean
  click?: () => void
}

/** The slice of Electron's `Tray` used here. */
export interface TrayLike {
  setToolTip(text: string): void
  setContextMenu(menu: never): void
  on(event: 'click', listener: () => void): unknown
  destroy(): void
}

/** The tooltip refreshes this often while a countdown is in progress. */
export const TRAY_TICK_MS = 1_000

export function trayMenuTemplate(state: TrayState, actions: TrayActions): TrayMenuItem[] {
  return [
    {
      label: state.quickHidden ? 'Show groups' : 'Hide groups',
      click: () => actions.toggleQuickHide()
    },
    { label: 'Peek', click: () => actions.togglePeek() },
    {
      label: 'Tools widget',
      type: 'checkbox',
      checked: state.toolsShown,
      click: () => actions.toggleTools()
    },
    { type: 'separator' },
    { label: 'Settings…', click: () => actions.openSettings() },
    { label: 'Refresh desktop', click: () => actions.refreshDesktop() },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: state.autostart,
      click: () => actions.setAutostart(!state.autostart)
    },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: () => actions.quit() }
  ]
}

export function trayTooltip(timerText: string | null): string {
  return timerText === null ? APP_NAME : `${APP_NAME} · ${timerText}`
}

export interface AppTrayDeps {
  createTray(): TrayLike
  buildMenu(template: TrayMenuItem[]): unknown
  state(): TrayState
  actions: TrayActions
}

export interface AppTray {
  /** Rebuilds the menu and the tooltip from the current state (call it whenever that changes). */
  refresh(): void
  dispose(): void
}

/**
 * Creates the tray icon. A left click toggles Peek (the quickest way to see the desktop); the
 * menu is rebuilt on `refresh()`, never on the 1 s tooltip tick (that would close an open menu).
 */
export function createAppTray(deps: AppTrayDeps): AppTray {
  const tray = deps.createTray()
  let ticker: ReturnType<typeof setInterval> | null = null
  let disposed = false

  const stopTicking = (): void => {
    if (ticker !== null) clearInterval(ticker)
    ticker = null
  }

  const tick = (): void => {
    const { timerText } = deps.state()
    tray.setToolTip(trayTooltip(timerText))
    if (timerText === null) stopTicking()
    else if (ticker === null) ticker = setInterval(tick, TRAY_TICK_MS)
  }

  const refresh = (): void => {
    if (disposed) return
    tray.setContextMenu(deps.buildMenu(trayMenuTemplate(deps.state(), deps.actions)) as never)
    tick()
  }

  tray.on('click', () => deps.actions.togglePeek())
  refresh()

  return {
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      stopTicking()
      tray.destroy()
    }
  }
}
