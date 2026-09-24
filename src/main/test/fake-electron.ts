import { EventEmitter } from 'node:events'
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron'
import type { FakeWin32Api } from '../win32/fake-api'
import type { DisplayInfo } from '../windows/display-ipc'

/** Test doubles for the slices of Electron's BrowserWindow, screen and powerMonitor we use. */

export interface KeyInput {
  type: 'keyDown' | 'keyUp'
  key: string
  alt: boolean
  control: boolean
  shift: boolean
  meta: boolean
}

export class FakeWebContents extends EventEmitter {
  readonly sent: { channel: string; payload: unknown }[] = []
  windowOpenHandler: (() => unknown) | null = null
  reloads = 0

  reload(): void {
    this.reloads++
  }

  /** Emits `before-input-event` for a key press; true when a listener prevented it. */
  pressKey(input: Partial<KeyInput> & { key: string }): boolean {
    let prevented = false
    this.emit(
      'before-input-event',
      {
        preventDefault: () => {
          prevented = true
        }
      },
      { type: 'keyDown', alt: false, control: false, shift: false, meta: false, ...input }
    )
    return prevented
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }

  sentOn(channel: string): unknown[] {
    return this.sent.filter((message) => message.channel === channel).map((m) => m.payload)
  }

  setWindowOpenHandler(handler: () => unknown): void {
    this.windowOpenHandler = handler
  }
}

let nextHwnd = 0x9000n

export class FakeBrowserWindow extends EventEmitter {
  static instances: FakeBrowserWindow[] = []
  /** Called on showInactive(), so a test can interleave it with Win32 calls. */
  static observe: ((event: 'showInactive', window: FakeBrowserWindow) => void) | null = null

  readonly webContents = new FakeWebContents()
  readonly hwnd = nextHwnd++
  readonly loads: { kind: 'url' | 'file'; target: string; query?: Record<string, string> }[] = []
  readonly boundsSet: Rectangle[] = []
  bounds: Rectangle
  menuRemoved = false
  visible = false
  minimized = false
  destroyed = false

  constructor(readonly options: BrowserWindowConstructorOptions) {
    super()
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 0,
      height: options.height ?? 0
    }
    FakeBrowserWindow.instances.push(this)
  }

  getNativeWindowHandle(): Buffer {
    const handle = Buffer.alloc(8)
    handle.writeBigUInt64LE(this.hwnd)
    return handle
  }

  getTitle(): string {
    return this.options.title ?? ''
  }

  loadURL(url: string): Promise<void> {
    this.loads.push({ kind: 'url', target: url })
    return Promise.resolve()
  }

  loadFile(path: string, options?: { query?: Record<string, string> }): Promise<void> {
    this.loads.push({ kind: 'file', target: path, query: options?.query })
    return Promise.resolve()
  }

  setBounds(bounds: Rectangle): void {
    this.boundsSet.push({ ...bounds })
    this.bounds = { ...bounds }
  }

  getBounds(): Rectangle {
    return { ...this.bounds }
  }

  hide(): void {
    this.visible = false
  }

  removeMenu(): void {
    this.menuRemoved = true
  }

  /** Electron's SW_SHOWNOACTIVATE path: shows or un-minimizes without focusing. */
  showInactive(): void {
    this.visible = true
    this.minimized = false
    FakeBrowserWindow.observe?.('showInactive', this)
  }

  isVisible(): boolean {
    return this.visible
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  /** Like BrowserWindow.close() (and Alt+F4): a `close` listener may cancel it. */
  close(): void {
    if (this.destroyed) return
    let prevented = false
    this.emit('close', {
      preventDefault: () => {
        prevented = true
      }
    })
    if (prevented) return
    this.destroyed = true
    this.emit('closed')
  }

  /** Like BrowserWindow.destroy(): gone without a cancellable `close`. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  }

  /** Simulates the first paint: Electron's `ready-to-show`. */
  becomeReady(): void {
    this.emit('ready-to-show')
  }
}

export type FakeDisplay = DisplayInfo & { rotation: number; internal: boolean }

export function fakeDisplay(
  id: number,
  bounds: Rectangle,
  scaleFactor = 1,
  taskbarHeight = 48
): FakeDisplay {
  return {
    id,
    bounds,
    workArea: { ...bounds, height: bounds.height - taskbarHeight },
    scaleFactor,
    rotation: 0,
    internal: false
  }
}

export class FakeScreen extends EventEmitter {
  constructor(public displays: FakeDisplay[]) {
    super()
  }

  getAllDisplays(): FakeDisplay[] {
    return this.displays
  }

  addDisplay(display: FakeDisplay): void {
    this.displays = [...this.displays, display]
    this.emit('display-added', {}, display)
  }

  removeDisplay(id: number): void {
    const removed = this.displays.find((display) => display.id === id)
    this.displays = this.displays.filter((display) => display.id !== id)
    this.emit('display-removed', {}, removed)
  }

  changeDisplay(display: FakeDisplay, changedMetrics: string[]): void {
    this.displays = this.displays.map((d) => (d.id === display.id ? display : d))
    this.emit('display-metrics-changed', {}, display, changedMetrics)
  }
}

export class FakePowerMonitor extends EventEmitter {}

export interface FakeElectron {
  BrowserWindow: typeof FakeBrowserWindow
  screen: FakeScreen
  powerMonitor: FakePowerMonitor
}

/** Two monitors like the development machine: 2560x1440 primary, 1920x1080 to its right. */
export const PRIMARY_DISPLAY = fakeDisplay(2450156880, { x: 0, y: 0, width: 2560, height: 1440 })
export const SECONDARY_DISPLAY = fakeDisplay(
  1529295726,
  { x: 2560, y: 0, width: 1920, height: 1080 },
  1.5
)

/**
 * Records, in order, every showInactive() on a fake window and every show/seat/guard call on
 * `api`, as `"<method> <hwnd>"` strings.
 */
export function recordShowOrder(api: FakeWin32Api): string[] {
  const order: string[] = []
  FakeBrowserWindow.observe = (event, window) => order.push(`${event} ${window.hwnd}`)
  const traced = ['showNoActivate', 'seatAboveShell', 'installZOrderGuard'] as const
  const methods = api as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const method of traced) {
    const original = methods[method].bind(api)
    methods[method] = (...args: unknown[]) => {
      order.push(`${method} ${String(args[0])}`)
      return original(...args)
    }
  }
  return order
}

export function createFakeElectron(displays = [PRIMARY_DISPLAY, SECONDARY_DISPLAY]): FakeElectron {
  FakeBrowserWindow.instances = []
  FakeBrowserWindow.observe = null
  return {
    BrowserWindow: FakeBrowserWindow,
    screen: new FakeScreen(displays),
    powerMonitor: new FakePowerMonitor()
  }
}
