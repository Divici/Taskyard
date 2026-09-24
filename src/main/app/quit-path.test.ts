import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createFakeElectron, FakeBrowserWindow } from '../test/fake-electron'
import { createFakeWin32Api } from '../win32/fake-api'
import { createDesktopWindowManager } from '../windows/desktop-window-manager'
import { installQuitPath, type QuittableDesktop } from './quit-path'

interface QuitEvent {
  preventDefault(): void
  readonly defaultPrevented: boolean
}

/**
 * An `app` that quits like Electron: quit() emits before-quit to every listener; unless one of
 * them prevented it, the windows are asked to close, and only when all of them closed is
 * will-quit emitted. `windowsClose` false models windows that are still closing (slow unload).
 */
class FakeApp extends EventEmitter {
  windowsClose = true
  /** Called between before-quit and will-quit, as a window's last save would arrive. */
  whileClosing: () => void = () => {}
  readonly quitEvents: QuitEvent[] = []
  readonly quit = vi.fn(() => {
    let prevented = false
    const event: QuitEvent = {
      preventDefault: () => {
        prevented = true
      },
      get defaultPrevented() {
        return prevented
      }
    }
    this.quitEvents.push(event)
    this.emit('before-quit', event)
    if (prevented || !this.windowsClose) return
    this.whileClosing()
    this.emit('will-quit', { preventDefault: () => {}, defaultPrevented: false })
  })

  /** The windows that were still closing have closed: the quit completes. */
  finishClosing(): void {
    this.emit('will-quit', { preventDefault: () => {}, defaultPrevented: false })
  }
}

interface FakeDesktop extends QuittableDesktop {
  quitting: boolean
  prepareToQuit: Mock<() => void>
  cancelQuit: Mock<() => void>
  dispose: Mock<() => void>
}

function fakeDesktop(): FakeDesktop {
  const desktop = {
    quitting: false,
    prepareToQuit: vi.fn(() => {
      desktop.quitting = true
    }),
    cancelQuit: vi.fn(() => {
      desktop.quitting = false
    }),
    dispose: vi.fn()
  }
  return desktop
}

function stores(): {
  dirty: boolean
  release: () => void
  hasPendingWrites: () => boolean
  flushAll: Mock<() => Promise<void>>
  flushAllSync: Mock<() => void>
} {
  let release = (): void => {}
  const target = {
    dirty: false,
    release: () => release(),
    hasPendingWrites: () => target.dirty,
    flushAll: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            target.dirty = false
            resolve()
          }
        })
    ),
    flushAllSync: vi.fn()
  }
  return target
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

let app: FakeApp
let desktop: FakeDesktop | null
let storage: ReturnType<typeof stores>

function install(): void {
  installQuitPath(app, { storage, desktop: () => desktop, log })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  app = new FakeApp()
  desktop = fakeDesktop()
  storage = stores()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('installQuitPath', () => {
  it('marks the desktop windows quitting when the quit goes ahead, and disposes them on will-quit', () => {
    install()

    app.quit()

    expect(desktop!.prepareToQuit).toHaveBeenCalledOnce()
    expect(desktop!.dispose).toHaveBeenCalledOnce()
    expect(log.info).toHaveBeenCalledWith('app: before-quit')
    vi.advanceTimersByTime(60_000)
    expect(desktop!.cancelQuit).not.toHaveBeenCalled()
  })

  it('keeps the desktop windows guarded while the stores flush, and marks them only when the quit proceeds', async () => {
    storage.dirty = true
    install()

    app.quit()

    expect(app.quitEvents[0].defaultPrevented).toBe(true)
    expect(storage.flushAll).toHaveBeenCalledOnce()
    expect(desktop!.prepareToQuit).not.toHaveBeenCalled()
    expect(desktop!.quitting).toBe(false)

    storage.release()
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(2))

    expect(app.quitEvents[1].defaultPrevented).toBe(false)
    expect(desktop!.prepareToQuit).toHaveBeenCalledOnce()
    expect(desktop!.dispose).toHaveBeenCalledOnce()
    expect(desktop!.cancelQuit).not.toHaveBeenCalled()
  })

  it('cancels the desktop quit on the next tick when a later before-quit listener prevented it', () => {
    install()
    app.on('before-quit', (event: QuitEvent) => event.preventDefault())

    app.quit()
    expect(desktop!.quitting).toBe(true)
    vi.advanceTimersByTime(0)

    expect(desktop!.cancelQuit).toHaveBeenCalledOnce()
    expect(desktop!.quitting).toBe(false)
    expect(log.warn).toHaveBeenCalledWith(
      'app: quit cancelled (a before-quit listener prevented it); the desktop windows stay'
    )
  })

  it('never takes a slow quit for a cancelled one: windows still closing a minute later stay quitting', () => {
    install()
    app.windowsClose = false

    app.quit()
    vi.advanceTimersByTime(60_000)

    expect(desktop!.cancelQuit).not.toHaveBeenCalled()
    expect(desktop!.quitting).toBe(true)
    app.finishClosing()
    expect(desktop!.dispose).toHaveBeenCalledOnce()
  })

  it('writes a save that arrived after the last before-quit synchronously at will-quit', () => {
    install()
    app.whileClosing = () => {
      // A window's last change was accepted while the windows closed: it sits in the debounce.
      storage.dirty = true
    }

    app.quit()

    expect(storage.flushAllSync).toHaveBeenCalledOnce()
    expect(log.info).toHaveBeenCalledWith('quit: wrote late changes at will-quit')
  })

  it('writes nothing at will-quit when everything is already on disk', () => {
    install()

    app.quit()

    expect(storage.flushAllSync).not.toHaveBeenCalled()
  })

  it('logs a failing will-quit write instead of throwing into Electron, and still disposes', () => {
    install()
    const failure = new Error('disk gone')
    storage.flushAllSync.mockImplementation(() => {
      throw failure
    })
    app.whileClosing = () => {
      storage.dirty = true
    }

    expect(() => app.quit()).not.toThrow()

    expect(log.error).toHaveBeenCalledWith(
      'quit: writing late changes at will-quit failed',
      failure
    )
    expect(desktop!.dispose).toHaveBeenCalledOnce()
  })

  it('quits straight through when there is no desktop (Win32 unavailable or start failed)', () => {
    desktop = null
    install()

    expect(() => app.quit()).not.toThrow()
    vi.advanceTimersByTime(0)
    expect(app.quitEvents[0].defaultPrevented).toBe(false)
  })

  it('quits on window-all-closed only when there is no desktop or it is already quitting', () => {
    install()

    app.emit('window-all-closed')
    expect(app.quit).not.toHaveBeenCalled()

    desktop!.quitting = true
    app.emit('window-all-closed')
    expect(app.quit).toHaveBeenCalledOnce()

    desktop = null
    app.emit('window-all-closed')
    expect(app.quit).toHaveBeenCalledTimes(2)
  })

  it('flushes synchronously when Windows ends the session (no before-quit then)', () => {
    install()
    const window = new EventEmitter()
    app.emit('browser-window-created', {}, window)

    window.emit('session-end')

    expect(storage.flushAllSync).toHaveBeenCalledOnce()
  })
})

describe('installQuitPath with the real desktop window manager', () => {
  it('re-guards the windows after a cancelled quit: an outside close is refused again', () => {
    const electron = createFakeElectron()
    const requestQuit = vi.fn()
    const manager = createDesktopWindowManager({
      electron,
      api: createFakeWin32Api(),
      preloadPath: 'C:\\app\\out\\preload\\index.js',
      renderer: { kind: 'file', path: 'C:\\app\\out\\renderer\\index.html' },
      log: { ...log, verbose: vi.fn(), debug: vi.fn() },
      requestQuit
    })
    manager.start()
    for (const window of FakeBrowserWindow.instances) window.becomeReady()
    installQuitPath(app, { storage, desktop: () => manager, log })
    app.on('before-quit', (event: QuitEvent) => event.preventDefault())

    app.quit()
    vi.advanceTimersByTime(0)
    const [first] = FakeBrowserWindow.instances
    first.close()

    expect(manager.quitting).toBe(false)
    expect(first.destroyed).toBe(false)
    vi.advanceTimersByTime(0)
    expect(requestQuit).toHaveBeenCalledOnce()
    manager.dispose()
  })

  it('lets no page block the quit: a beforeunload veto is overridden once the app is quitting', () => {
    const electron = createFakeElectron()
    const manager = createDesktopWindowManager({
      electron,
      api: createFakeWin32Api(),
      preloadPath: 'C:\\app\\out\\preload\\index.js',
      renderer: { kind: 'file', path: 'C:\\app\\out\\renderer\\index.html' },
      log: { ...log, verbose: vi.fn(), debug: vi.fn() },
      requestQuit: vi.fn()
    })
    manager.start()
    installQuitPath(app, { storage, desktop: () => manager, log })
    const [first] = FakeBrowserWindow.instances
    // Before any quit, a page's beforeunload is its own business.
    expect(first.webContents.tryToBlockUnload()).toBe(false)

    app.windowsClose = false
    app.quit()

    // will-prevent-unload: preventDefault() ignores the page's veto, so the window closes.
    expect(first.webContents.tryToBlockUnload()).toBe(true)
    manager.dispose()
  })
})
