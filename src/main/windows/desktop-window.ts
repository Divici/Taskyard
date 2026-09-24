import type { BrowserWindowConstructorOptions, Rectangle } from 'electron'
import { APP_NAME } from '@shared/app-info'
import type { Hwnd, Win32Api, ZOrderMode } from '../win32/api'
import { forwardRendererConsole, type ConsoleMessageSource } from './renderer-console'
import { secureWebPreferences } from './window-options'

/**
 * The window stops this many DIPs short of the display's bottom edge, so the shell never
 * treats a focused Taskyard as a full-screen app (which keeps an auto-hide taskbar hidden).
 */
export const DESKTOP_BOTTOM_INSET = 1

/** If `ready-to-show` has not fired by then, the window is shown and seated anyway. */
export const READY_TO_SHOW_TIMEOUT_MS = 10_000
/** A crashed renderer is reloaded, but at most this many times per window … */
export const CRASH_RELOAD_LIMIT = 3
/** … within this long; past that the window is hidden (Explorer's desktop shows) … */
export const CRASH_RELOAD_WINDOW_MS = 60_000
/** … and one reload is retried after this cool-down (again after each failed retry). */
export const CRASH_RETRY_COOLDOWN_MS = 5 * 60_000

/** Where the renderer comes from: the Vite dev server, or the built index.html. */
export type RendererSource = { kind: 'url'; url: string } | { kind: 'file'; path: string }

/** The part of Electron's `Display` a desktop window is laid out from. */
export interface DesktopDisplay {
  id: number
  bounds: Rectangle
}

/** The fields of Electron's `before-input-event` input used to block shortcuts. */
export interface KeyInputLike {
  type: string
  key: string
  alt: boolean
  control: boolean
  shift: boolean
  meta: boolean
}

/**
 * Keys that would close the desktop layer: Alt+F4 (system close) and Ctrl+W (the default
 * menu's Window › Close). Blocked on key-down before the page or any accelerator sees them.
 * This does not depend on the Win32 guard, which may fail to install.
 */
export function isBlockedDesktopShortcut(input: KeyInputLike): boolean {
  if (input.type !== 'keyDown') return false
  const key = input.key.toLowerCase()
  return (input.alt && key === 'f4') || (input.control && key === 'w')
}

export interface DesktopWebContents {
  send(channel: string, payload: unknown): void
  reload(): void
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
  on(...args: Parameters<ConsoleMessageSource['on']>): unknown
  on(event: 'did-finish-load', listener: () => void): unknown
  on(
    event: 'before-input-event',
    listener: (event: { preventDefault(): void }, input: KeyInputLike) => void
  ): unknown
  on(event: 'render-process-gone', listener: (event: unknown, details: unknown) => void): unknown
  on(
    event: 'preload-error',
    listener: (event: unknown, preloadPath: string, error: Error) => void
  ): unknown
}

/** The slice of Electron's `BrowserWindow` a desktop window uses (a fake in unit tests). */
export interface DesktopBrowserWindow {
  readonly webContents: DesktopWebContents
  getNativeWindowHandle(): Buffer
  loadURL(url: string): Promise<void>
  loadFile(path: string, options?: { query?: Record<string, string> }): Promise<void>
  setBounds(bounds: Rectangle): void
  /** SW_SHOWNOACTIVATE through Chromium, which then also resumes painting. */
  showInactive(): void
  hide(): void
  /** No menu: none of the default accelerators (Ctrl+W, Ctrl+R, Ctrl+Shift+I, Ctrl+M, zoom). */
  removeMenu(): void
  isVisible(): boolean
  isMinimized(): boolean
  isDestroyed(): boolean
  close(): void
  on(
    event: 'focus' | 'show' | 'restore' | 'minimize' | 'closed' | 'session-end',
    listener: () => void
  ): unknown
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown
  once(event: 'ready-to-show', listener: () => void): unknown
}

export type DesktopBrowserWindowConstructor = new (
  options: BrowserWindowConstructorOptions
) => DesktopBrowserWindow

export interface DesktopLog {
  info(message: string, ...details: unknown[]): void
  warn(message: string, ...details: unknown[]): void
  error(message: string, ...details: unknown[]): void
  verbose(message: string, ...details: unknown[]): void
  debug(message: string, ...details: unknown[]): void
}

export interface DesktopWindowDeps {
  BrowserWindow: DesktopBrowserWindowConstructor
  api: Win32Api
  preloadPath: string
  renderer: RendererSource
  log: DesktopLog
  /** Where the guard keeps the window; the manager's `peeking` flag decides. */
  mode: () => ZOrderMode
  /** True while the app is quitting: only then may something other than the owner close it. */
  canClose: () => boolean
  /** The window is gone; `expected` is false when it was destroyed from outside. */
  onClosed: (window: DesktopWindow, info: { expected: boolean }) => void
  /**
   * Something outside Taskyard sent WM_CLOSE (taskkill, an installer). The window stays; the
   * owner turns this into a graceful app quit so before-quit (and the store flush) still run.
   */
  onCloseRequest: (window: DesktopWindow) => void
  readyTimeoutMs?: number
  /** A renderer finished (re)loading and needs its display and peek state again. */
  onRendererLoaded?: (window: DesktopWindow) => void
}

export interface DesktopWindow {
  readonly displayId: number
  readonly window: DesktopBrowserWindow
  readonly hwnd: Hwnd
  /** Shown, seated and guarded (after `ready-to-show` or its timeout, until closed). */
  readonly ready: boolean
  /** True when something minimized or hid the window. */
  displaced(): boolean
  /** Shows it again if needed, then seats it above the shell (or keeps it raised while peeking). */
  reseat(): void
  setDisplay(display: DesktopDisplay): void
  send(channel: string, payload: unknown): void
  /** Closes it on purpose (display removed); an outside close is refused. */
  close(): void
}

export function desktopWindowBounds({ bounds }: Pick<DesktopDisplay, 'bounds'>): Rectangle {
  return { ...bounds, height: bounds.height - DESKTOP_BOTTOM_INSET }
}

export function desktopWindowOptions(
  display: DesktopDisplay,
  preloadPath: string
): BrowserWindowConstructorOptions {
  return {
    title: APP_NAME,
    ...desktopWindowBounds(display),
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    roundedCorners: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    // Without this the HWND keeps WS_CAPTION and invisible 8 px borders around the content, so
    // its real rect covers the whole monitor and the shell sees a full-screen app.
    thickFrame: false,
    // WS_EX_TOOLWINDOW: no taskbar button and no Alt-Tab entry.
    type: 'toolbar',
    show: false,
    focusable: true,
    webPreferences: {
      ...secureWebPreferences(preloadPath),
      // Occluded by other apps most of the time, yet it must keep streaming icons and animate Peek.
      backgroundThrottling: false,
      additionalArguments: [`--display-id=${display.id}`]
    }
  }
}

export function desktopWindowUrl(devServerUrl: string, displayId: number): string {
  const url = new URL(devServerUrl)
  url.searchParams.set('displayId', String(displayId))
  return url.toString()
}

/** `getNativeWindowHandle()` is the HWND's bytes: 8 on 64-bit Windows, 4 on 32-bit. */
export function hwndFromHandle(handle: Buffer): Hwnd {
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))
}

/**
 * One desktop-layer window on `display`. After `ready-to-show` (or a 10 s timeout) it is shown
 * without activation (Electron's `showInactive`), seated directly above the shell window and
 * guarded; `focus`/`show`/`restore`/`minimize` re-seat it in case the guard missed a move. Only
 * its owner, app quit or session end may close it; a crashed renderer is reloaded.
 */
export function createDesktopWindow(
  display: DesktopDisplay,
  deps: DesktopWindowDeps
): DesktopWindow {
  const { api, log } = deps
  const window = new deps.BrowserWindow(desktopWindowOptions(display, deps.preloadPath))
  // Chromium clamps a new window to the display's work area (measured: 1032 instead of 1079 on
  // a 1080 px display with a 48 px taskbar); bounds set after creation are kept.
  window.setBounds(desktopWindowBounds(display))
  window.removeMenu()
  const hwnd = hwndFromHandle(window.getNativeWindowHandle())
  let ready = false
  let guarded = false
  /** The owner closes it, or Windows is ending the session: a close goes through. */
  let closeAllowed = false
  let crashes: number[] = []
  /** The renderer kept crashing: the window is hidden until a retry loads. */
  let gaveUp = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const place = (): void => {
    if (deps.mode() === 'peek') api.setTopmost(hwnd, true)
    else api.seatAboveShell(hwnd)
  }

  const dropGuard = (): void => {
    if (guarded) api.removeZOrderGuard(hwnd)
    guarded = false
  }

  const desktop: DesktopWindow = {
    displayId: display.id,
    window,
    hwnd,
    get ready() {
      return ready
    },
    displaced: () => window.isMinimized() || !window.isVisible(),
    reseat() {
      if (!ready) return
      if (desktop.displaced()) window.showInactive()
      place()
    },
    setDisplay(next) {
      window.setBounds(desktopWindowBounds(next))
    },
    send(channel, payload) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    },
    close() {
      closeAllowed = true
      if (!window.isDestroyed()) window.close()
    }
  }

  const show = (): void => {
    // Never show a window whose renderer gave up: it would be a dead black rectangle.
    if (ready || gaveUp || window.isDestroyed()) return
    // Not api.showNoActivate(hwnd): a raw ShowWindow bypasses Chromium, which then never paints
    // the window (the screen stays backgroundColor-black). showInactive is the same
    // SW_SHOWNOACTIVATE, routed through Chromium.
    window.showInactive()
    place()
    guarded = api.installZOrderGuard(hwnd, deps.mode)
    if (!guarded) log.warn(`desktop: z-order guard not installed on display ${display.id}`)
    ready = true
    log.info(`desktop: window shown on display ${display.id} (hwnd 0x${hwnd.toString(16)})`)
  }

  const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TO_SHOW_TIMEOUT_MS
  // A renderer that never paints must not leave the display without its desktop layer.
  const readyTimer = setTimeout(() => {
    if (ready) return
    log.warn(
      `desktop: no ready-to-show on display ${display.id} after ${readyTimeoutMs} ms; showing anyway`
    )
    show()
  }, readyTimeoutMs)
  window.once('ready-to-show', () => {
    clearTimeout(readyTimer)
    show()
  })
  for (const event of ['focus', 'show', 'restore', 'minimize'] as const) {
    window.on(event, () => desktop.reseat())
  }
  window.on('session-end', () => {
    closeAllowed = true
  })
  window.on('close', (event) => {
    if (!closeAllowed && !deps.canClose()) {
      // A WM_CLOSE from another app (Alt+F4 never gets here: the guard swallows SC_CLOSE).
      // Closing one window would leave its display bare; the owner quits the app instead.
      event.preventDefault()
      deps.onCloseRequest(desktop)
      return
    }
    ready = false
    dropGuard()
  })
  window.on('closed', () => {
    clearTimeout(readyTimer)
    if (retryTimer !== null) clearTimeout(retryTimer)
    ready = false
    dropGuard()
    deps.onClosed(desktop, { expected: closeAllowed || deps.canClose() })
  })

  const { webContents } = window
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('before-input-event', (event, input) => {
    if (isBlockedDesktopShortcut(input)) event.preventDefault()
  })
  forwardRendererConsole(webContents, log)
  const scheduleRetry = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (window.isDestroyed()) return
      log.info(`desktop: retrying the renderer on display ${display.id}`)
      webContents.reload()
    }, CRASH_RETRY_COOLDOWN_MS)
  }

  webContents.on('did-finish-load', () => {
    if (gaveUp) {
      // A retry loaded: bring the desktop layer back.
      gaveUp = false
      crashes = []
      log.info(`desktop: renderer on display ${display.id} recovered`)
      show()
    }
    deps.onRendererLoaded?.(desktop)
  })
  webContents.on('render-process-gone', (_event, details) => {
    log.error(`desktop: renderer process gone on display ${display.id}`, details)
    if (window.isDestroyed()) return
    if (gaveUp) {
      // The retry crashed as well: stay hidden and wait another cool-down.
      scheduleRetry()
      return
    }
    const now = Date.now()
    crashes = crashes.filter((at) => now - at < CRASH_RELOAD_WINDOW_MS)
    if (crashes.length >= CRASH_RELOAD_LIMIT) {
      // A dead black rectangle is worse than no desktop layer: show Explorer's desktop.
      gaveUp = true
      ready = false
      clearTimeout(readyTimer)
      window.hide()
      log.error(
        `desktop: renderer on display ${display.id} keeps crashing (${CRASH_RELOAD_LIMIT} reloads in ${CRASH_RELOAD_WINDOW_MS / 1000} s); hiding the window, retrying in ${CRASH_RETRY_COOLDOWN_MS / 60_000} min`
      )
      scheduleRetry()
      return
    }
    crashes.push(now)
    log.warn(`desktop: reloading the renderer on display ${display.id}`)
    webContents.reload()
  })
  webContents.on('preload-error', (_event, preloadPath, error) => {
    log.error(`desktop: preload failed (${preloadPath})`, error)
  })

  const loading =
    deps.renderer.kind === 'url'
      ? window.loadURL(desktopWindowUrl(deps.renderer.url, display.id))
      : window.loadFile(deps.renderer.path, { query: { displayId: String(display.id) } })
  loading.catch((error: unknown) => {
    log.error(`desktop: renderer failed to load on display ${display.id}`, error)
  })

  return desktop
}
