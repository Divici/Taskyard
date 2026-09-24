import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createFakeElectron, FakeBrowserWindow } from '../test/fake-electron'
import { createFakeWin32Api } from '../win32/fake-api'
import { createDesktopWindowManager } from '../windows/desktop-window-manager'
import { startDesktop } from './start-desktop'

interface FakeManager {
  start: Mock<() => void>
  windows: () => object[]
}

interface Deps {
  manager: FakeManager
  base: {
    clearApplicationMenu: Mock<() => void>
    createManager: Mock<() => FakeManager>
    registerIpc: Mock<(manager: FakeManager) => (() => void) | void>
    showErrorBox: Mock<(title: string, content: string) => void>
    quit: Mock<() => void>
    log: { info: Mock<(message: string) => void>; error: Mock<(message: string) => void> }
    logFile: string
  }
}

function deps(): Deps {
  const manager: FakeManager = { start: vi.fn(), windows: () => [{}, {}] }
  const base: Deps['base'] = {
    clearApplicationMenu: vi.fn(),
    createManager: vi.fn(() => manager),
    registerIpc: vi.fn(),
    showErrorBox: vi.fn<(title: string, content: string) => void>(),
    quit: vi.fn(),
    log: { info: vi.fn(), error: vi.fn() },
    logFile: 'C:\\Users\\me\\AppData\\Roaming\\Taskyard\\logs\\main.log'
  }
  return { manager, base }
}

describe('startDesktop', () => {
  it('creates, wires and starts the desktop windows when Win32 is available', () => {
    const api = createFakeWin32Api()
    const { manager, base } = deps()

    const result = startDesktop({ kind: 'koffi', api }, base)

    expect(result).toBe(manager)
    expect(base.createManager).toHaveBeenCalledExactlyOnceWith(api)
    expect(base.registerIpc).toHaveBeenCalledExactlyOnceWith(manager)
    expect(manager.start).toHaveBeenCalledOnce()
    expect(base.log.info).toHaveBeenCalledWith('desktop: 2 display window(s), koffi win32')
    expect(base.showErrorBox).not.toHaveBeenCalled()
  })

  it('removes the default application menu before any desktop window exists', () => {
    const { base } = deps()
    base.createManager.mockImplementation(() => {
      expect(base.clearApplicationMenu).toHaveBeenCalledOnce()
      return { start: vi.fn(), windows: () => [] }
    })

    startDesktop({ kind: 'fake', api: createFakeWin32Api() }, base)

    expect(base.createManager).toHaveBeenCalledOnce()
  })

  it('runs on the fake when asked to (TASKYARD_NO_WIN32=1)', () => {
    const { manager, base } = deps()

    expect(startDesktop({ kind: 'fake', api: createFakeWin32Api() }, base)).toBe(manager)
  })

  it('opens no window, explains in a dialog and quits when Win32 is unavailable', () => {
    const { base } = deps()

    const result = startDesktop(
      { kind: 'unavailable', reason: 'koffi could not load user32.dll' },
      base
    )

    expect(result).toBeNull()
    expect(base.createManager).not.toHaveBeenCalled()
    expect(base.registerIpc).not.toHaveBeenCalled()
    expect(base.showErrorBox).toHaveBeenCalledExactlyOnceWith(
      'Taskyard cannot start',
      expect.stringContaining('koffi could not load user32.dll')
    )
    expect(base.showErrorBox.mock.calls[0][1]).toContain(base.logFile)
    expect(base.log.error).toHaveBeenCalledWith(
      'app: Win32 unavailable (koffi could not load user32.dll); quitting'
    )
    expect(base.quit).toHaveBeenCalledOnce()
  })

  it('shuts down cleanly (dialog, quit, handlers removed) when the windows fail to start', () => {
    const { manager, base } = deps()
    const unregister = vi.fn()
    base.registerIpc.mockReturnValue(unregister)
    manager.start.mockImplementation(() => {
      throw new Error('GPU process unavailable')
    })

    const result = startDesktop({ kind: 'koffi', api: createFakeWin32Api() }, base)

    expect(result).toBeNull()
    expect(unregister).toHaveBeenCalledOnce()
    expect(base.log.error).toHaveBeenCalledWith(
      'app: the desktop windows failed to start (GPU process unavailable); quitting',
      expect.objectContaining({ message: 'GPU process unavailable' })
    )
    expect(base.showErrorBox).toHaveBeenCalledExactlyOnceWith(
      'Taskyard cannot start',
      expect.stringContaining('GPU process unavailable')
    )
    expect(base.showErrorBox.mock.calls[0][1]).toContain(base.logFile)
    expect(base.quit).toHaveBeenCalledOnce()
  })

  it('shuts down cleanly when the default menu cannot be removed (no window is opened)', () => {
    const { base } = deps()
    base.clearApplicationMenu.mockImplementation(() => {
      throw new Error('Menu unavailable')
    })

    expect(startDesktop({ kind: 'koffi', api: createFakeWin32Api() }, base)).toBeNull()
    expect(base.createManager).not.toHaveBeenCalled()
    expect(base.showErrorBox).toHaveBeenCalledExactlyOnceWith(
      'Taskyard cannot start',
      expect.stringContaining('Menu unavailable')
    )
    expect(base.quit).toHaveBeenCalledOnce()
  })

  it('shuts down cleanly when the manager cannot even be created', () => {
    const { base } = deps()
    base.createManager.mockImplementation(() => {
      throw new Error('no screen')
    })

    expect(startDesktop({ kind: 'fake', api: createFakeWin32Api() }, base)).toBeNull()
    expect(base.registerIpc).not.toHaveBeenCalled()
    expect(base.showErrorBox).toHaveBeenCalledOnce()
    expect(base.quit).toHaveBeenCalledOnce()
  })
})

describe('startDesktop with the real window manager', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves no window, listener or timer behind when the window for the second display fails', () => {
    vi.useFakeTimers()
    const electron = createFakeElectron()
    let built = 0
    electron.BrowserWindow = class extends FakeBrowserWindow {
      constructor(options: ConstructorParameters<typeof FakeBrowserWindow>[0]) {
        if (++built === 2) throw new Error('GPU process unavailable')
        super(options)
      }
    }
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn(), debug: vi.fn() }
    const quit = vi.fn()
    const unregister = vi.fn()

    const result = startDesktop(
      { kind: 'fake', api: createFakeWin32Api() },
      {
        clearApplicationMenu: vi.fn(),
        createManager: (api) =>
          createDesktopWindowManager({
            electron,
            api,
            preloadPath: 'C:\\app\\out\\preload\\index.js',
            renderer: { kind: 'file', path: 'C:\\app\\out\\renderer\\index.html' },
            log,
            requestQuit: vi.fn()
          }),
        registerIpc: () => unregister,
        showErrorBox: vi.fn(),
        quit,
        log,
        logFile: 'C:\\logs\\main.log'
      }
    )

    expect(result).toBeNull()
    expect(FakeBrowserWindow.instances.every((window) => window.destroyed)).toBe(true)
    expect(electron.screen.listenerCount('display-added')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(unregister).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })
})
