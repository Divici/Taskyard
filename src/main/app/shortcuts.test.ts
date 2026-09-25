import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, type ShortcutStatus } from '@shared/ipc'
import { defaultSettings } from '@shared/defaults'
import { FakeIpcMain, trustedEvent } from '../ipc/fake-ipc-main'
import { createFakeWin32Api } from '../win32/fake-api'
import { createFakeElectron, FakeBrowserWindow } from '../test/fake-electron'
import {
  createDesktopWindowManager,
  IDLE_UNPEEK_MS,
  type DesktopWindowManager
} from '../windows/desktop-window-manager'
import {
  createPeekShortcuts,
  registerPeekIpc,
  type GlobalShortcutLike,
  type PeekShortcuts,
  type PeekTarget
} from './shortcuts'

/** Electron's globalShortcut: one owner per accelerator; `taken` ones belong to other apps. */
function fakeGlobalShortcut(taken: string[] = []): GlobalShortcutLike & {
  registered: Map<string, () => void>
  press(accelerator: string): void
} {
  const registered = new Map<string, () => void>()
  return {
    registered,
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (taken.includes(accelerator) || registered.has(accelerator)) return false
      registered.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator: string) => {
      registered.delete(accelerator)
    }),
    press(accelerator) {
      registered.get(accelerator)?.()
    }
  }
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn(), debug: vi.fn() }

/** The real window manager over fakes: peek, holds and the idle timer are its own. */
function realManager(): DesktopWindowManager {
  const manager = createDesktopWindowManager({
    electron: createFakeElectron(),
    api: createFakeWin32Api(),
    preloadPath: 'C:\\app\\out\\preload\\index.js',
    renderer: { kind: 'file', path: 'C:\\app\\out\\renderer\\index.html' },
    log,
    requestQuit: vi.fn()
  })
  manager.start()
  for (const window of FakeBrowserWindow.instances) {
    window.becomeReady()
    window.visible = true
  }
  return manager
}

let shortcut: ReturnType<typeof fakeGlobalShortcut>
let manager: DesktopWindowManager
let emit: ReturnType<typeof vi.fn<(status: ShortcutStatus) => void>>
let shortcuts: PeekShortcuts

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  shortcut = fakeGlobalShortcut(['Ctrl+Alt+T'])
  manager = realManager()
  emit = vi.fn()
  shortcuts = createPeekShortcuts({ globalShortcut: shortcut, target: () => manager, emit, log })
})

afterEach(() => {
  shortcuts.dispose()
  manager.dispose()
  vi.useRealTimers()
})

describe('Peek shortcut registration', () => {
  it('registers the settings shortcut; pressing it toggles Peek on the window manager', () => {
    expect(shortcuts.start(defaultSettings())).toEqual({
      accelerator: 'Ctrl+Alt+Space',
      active: 'Ctrl+Alt+Space',
      error: null
    })
    expect(shortcut.registered.has('Ctrl+Alt+Space')).toBe(true)

    shortcut.press('Ctrl+Alt+Space')
    expect(manager.peeking).toBe(true)
    shortcut.press('Ctrl+Alt+Space')
    expect(manager.peeking).toBe(false)
  })

  it('re-registers when the settings change: the old accelerator is released, the new one works', () => {
    shortcuts.start(defaultSettings())

    shortcuts.applySettings({ ...defaultSettings(), peekShortcut: 'ctrl+shift+p' })

    expect(shortcut.unregister).toHaveBeenCalledWith('Ctrl+Alt+Space')
    expect([...shortcut.registered.keys()]).toEqual(['Ctrl+Shift+P'])
    expect(emit).toHaveBeenLastCalledWith({
      accelerator: 'Ctrl+Shift+P',
      active: 'Ctrl+Shift+P',
      error: null
    })
    shortcut.press('Ctrl+Shift+P')
    expect(manager.peeking).toBe(true)
  })

  it('ignores settings saves that do not change the shortcut (no re-registration, no event)', () => {
    shortcuts.start(defaultSettings())
    vi.mocked(shortcut.register).mockClear()
    emit.mockClear()

    shortcuts.applySettings({ ...defaultSettings(), iconSize: 'large' })

    expect(shortcut.register).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('reports an accelerator another app owns (register → false) and keeps the previous one', () => {
    shortcuts.start(defaultSettings())

    const status = shortcuts.setShortcut('Ctrl+Alt+T')

    expect(status).toEqual({ accelerator: 'Ctrl+Alt+T', active: 'Ctrl+Alt+Space', error: 'in-use' })
    expect(emit).toHaveBeenLastCalledWith(status)
    expect(shortcuts.status()).toEqual(status)
    expect([...shortcut.registered.keys()]).toEqual(['Ctrl+Alt+Space'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Ctrl+Alt+T'))
    shortcut.press('Ctrl+Alt+Space')
    expect(manager.peeking).toBe(true)
  })

  it('reports an invalid accelerator without touching the registered one', () => {
    shortcuts.start(defaultSettings())
    vi.mocked(shortcut.unregister).mockClear()

    expect(shortcuts.setShortcut('Ctrl+Alt+Spacebar')).toEqual({
      accelerator: 'Ctrl+Alt+Spacebar',
      active: 'Ctrl+Alt+Space',
      error: 'invalid'
    })
    expect(shortcut.unregister).not.toHaveBeenCalled()
    expect(shortcut.registered.has('Ctrl+Alt+Space')).toBe(true)
  })

  it('an accelerator Electron throws on is invalid too, and the previous one is restored', () => {
    shortcuts.start(defaultSettings())

    expect(shortcuts.setShortcut('Ctrl+Alt+F1')).toMatchObject({
      error: null
    })
    vi.mocked(shortcut.register).mockImplementationOnce(() => {
      throw new Error('conversion failure')
    })
    expect(shortcuts.setShortcut('Ctrl+Alt+F2')).toEqual({
      accelerator: 'Ctrl+Alt+F2',
      active: 'Ctrl+Alt+F1',
      error: 'invalid'
    })
    expect([...shortcut.registered.keys()]).toEqual(['Ctrl+Alt+F1'])
  })

  it('a default already taken at start leaves Peek without a shortcut, and says so', () => {
    const busy = fakeGlobalShortcut(['Ctrl+Alt+Space'])
    const blocked = createPeekShortcuts({ globalShortcut: busy, target: () => manager, emit, log })

    expect(blocked.start(defaultSettings())).toEqual({
      accelerator: 'Ctrl+Alt+Space',
      active: null,
      error: 'in-use'
    })
    // The same setting is not retried on every save; a new value is.
    vi.mocked(busy.register).mockClear()
    blocked.applySettings({ ...defaultSettings(), glow: false })
    expect(busy.register).not.toHaveBeenCalled()
    blocked.applySettings({ ...defaultSettings(), peekShortcut: 'Ctrl+Alt+P' })
    expect(blocked.status()).toEqual({
      accelerator: 'Ctrl+Alt+P',
      active: 'Ctrl+Alt+P',
      error: null
    })
    blocked.dispose()
  })

  it('unregisters its shortcut on dispose (will-quit)', () => {
    shortcuts.start(defaultSettings())
    shortcuts.dispose()
    expect(shortcut.registered.size).toBe(0)
  })
})

describe('togglePeek and the second-instance Peek', () => {
  it('togglePeek flips Peek (the tray uses it); showPeek only turns it on', () => {
    shortcuts.togglePeek()
    expect(manager.peeking).toBe(true)
    shortcuts.showPeek()
    expect(manager.peeking).toBe(true)
    shortcuts.togglePeek()
    expect(manager.peeking).toBe(false)
    shortcuts.showPeek()
    expect(manager.peeking).toBe(true)
  })

  it('does nothing before the desktop windows exist', () => {
    const early = createPeekShortcuts({ globalShortcut: shortcut, target: () => null, emit, log })
    expect(() => early.togglePeek()).not.toThrow()
    expect(() => early.showPeek()).not.toThrow()
  })
})

describe('auto-unpeek', () => {
  it(`unpeeks after ${IDLE_UNPEEK_MS / 1000} s idle; activity restarts the timer`, () => {
    shortcuts.togglePeek()
    vi.advanceTimersByTime(IDLE_UNPEEK_MS - 1_000)
    shortcuts.activity()
    vi.advanceTimersByTime(IDLE_UNPEEK_MS - 1_000)
    expect(manager.peeking).toBe(true)
    vi.advanceTimersByTime(1_000)
    expect(manager.peeking).toBe(false)
  })

  it('the idle timer is paused while any window has a text input focused', () => {
    shortcuts.togglePeek()
    shortcuts.inputFocus(1, true)
    shortcuts.inputFocus(2, true)
    vi.advanceTimersByTime(IDLE_UNPEEK_MS * 3)
    expect(manager.peeking).toBe(true)

    shortcuts.inputFocus(1, false)
    vi.advanceTimersByTime(IDLE_UNPEEK_MS * 3)
    expect(manager.peeking).toBe(true)

    shortcuts.inputFocus(2, false)
    vi.advanceTimersByTime(IDLE_UNPEEK_MS)
    expect(manager.peeking).toBe(false)
  })

  it('a new Peek starts with no stale input focus (renderers report theirs again)', () => {
    shortcuts.togglePeek()
    shortcuts.inputFocus(7, true)
    shortcuts.togglePeek()
    shortcuts.togglePeek()
    vi.advanceTimersByTime(IDLE_UNPEEK_MS)
    expect(manager.peeking).toBe(false)
  })

  it('a window reloaded while typing (same webContents id) does not leave the idle timer paused', () => {
    shortcuts.togglePeek()
    const [first] = FakeBrowserWindow.instances
    shortcuts.inputFocus(first.webContents.id, true)
    // The page reloads; the fresh renderer has nothing focused and never says "false".
    first.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    first.webContents.emit('did-finish-load')
    vi.advanceTimersByTime(IDLE_UNPEEK_MS)
    expect(manager.peeking).toBe(false)
  })

  it('a pause from an earlier Peek does not block a held Peek started on the manager', () => {
    shortcuts.togglePeek()
    shortcuts.inputFocus(4, true)
    shortcuts.togglePeek()
    manager.peek(true, { hold: 'inspector' })
    manager.releaseHold('inspector')
    vi.advanceTimersByTime(IDLE_UNPEEK_MS)
    expect(manager.peeking).toBe(false)
  })

  it("an 'inspector' hold suppresses the idle unpeek until it is released", () => {
    manager.peek(true, { hold: 'inspector' })
    vi.advanceTimersByTime(IDLE_UNPEEK_MS * 3)
    expect(manager.peeking).toBe(true)

    manager.releaseHold('inspector')
    vi.advanceTimersByTime(IDLE_UNPEEK_MS)
    expect(manager.peeking).toBe(false)
  })

  it('a click outside a group unpeeks at once, even with a hold', () => {
    manager.peek(true, { hold: 'inspector' })
    shortcuts.clickOutside()
    expect(manager.peeking).toBe(false)
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('click outside'))
  })

  it('a click outside while not peeking changes nothing', () => {
    const target: PeekTarget = {
      peeking: false,
      peek: vi.fn(),
      pauseIdle: vi.fn(),
      noteActivity: vi.fn()
    }
    const idle = createPeekShortcuts({ globalShortcut: shortcut, target: () => target, emit, log })
    idle.clickOutside()
    expect(target.peek).not.toHaveBeenCalled()
  })
})

describe('peek IPC', () => {
  let ipc: FakeIpcMain
  const trust = { isTrustedSender: () => true, log }

  beforeEach(() => {
    ipc = new FakeIpcMain()
    registerPeekIpc(ipc, trust, { shortcuts, peeking: () => manager.peeking })
  })

  it('peek:get answers the current state (a window that loads during Peek)', async () => {
    expect(await ipc.invoke(IPC.peek.get)).toEqual({ peeking: false })
    manager.peek(true)
    expect(await ipc.invoke(IPC.peek.get)).toEqual({ peeking: true })
  })

  it('peek:inputFocus pauses the idle timer per window (the sender)', async () => {
    shortcuts.togglePeek()
    await ipc.invokeFrom(trustedEvent(3), IPC.peek.inputFocus, true)
    vi.advanceTimersByTime(IDLE_UNPEEK_MS * 2)
    expect(manager.peeking).toBe(true)
    await ipc.invokeFrom(trustedEvent(3), IPC.peek.inputFocus, false)
    vi.advanceTimersByTime(IDLE_UNPEEK_MS)
    expect(manager.peeking).toBe(false)
  })

  it('peek:activity restarts the idle timer; peek:clickOutside unpeeks', async () => {
    shortcuts.togglePeek()
    vi.advanceTimersByTime(IDLE_UNPEEK_MS - 1)
    await ipc.invoke(IPC.peek.activity)
    vi.advanceTimersByTime(IDLE_UNPEEK_MS - 1)
    expect(manager.peeking).toBe(true)
    await ipc.invoke(IPC.peek.clickOutside)
    expect(manager.peeking).toBe(false)
  })

  it('peek:shortcutStatus answers the registration outcome', async () => {
    shortcuts.start(defaultSettings())
    shortcuts.setShortcut('Ctrl+Alt+T')
    expect(await ipc.invoke(IPC.peek.shortcutStatus)).toEqual({
      accelerator: 'Ctrl+Alt+T',
      active: 'Ctrl+Alt+Space',
      error: 'in-use'
    })
  })

  it('refuses malformed arguments', async () => {
    await expect(ipc.invoke(IPC.peek.inputFocus, 'yes')).rejects.toThrow(/invalid arguments/)
    await expect(ipc.invoke(IPC.peek.clickOutside, 1)).rejects.toThrow(/invalid arguments/)
  })
})
