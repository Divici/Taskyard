import { describe, expect, it, vi, type Mock } from 'vitest'
import { createFakeWin32Api } from '../win32/fake-api'
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
    registerIpc: Mock<(manager: FakeManager) => void>
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
})
