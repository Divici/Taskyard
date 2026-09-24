import { describe, expect, it, vi } from 'vitest'
import type { ZOrderMode } from './api'
import { createFakeWin32Api, FAKE_APP_WINDOW, FAKE_SHELL_WINDOW } from './fake-api'

const OURS = 0x5001n
const OTHER = 0x5002n

describe('createFakeWin32Api', () => {
  it('records every call with its arguments, in order', () => {
    const api = createFakeWin32Api()

    api.showNoActivate(OURS)
    api.seatAboveShell(OURS)
    api.setTopmost(OURS, true)
    api.isAbove(OURS, FAKE_SHELL_WINDOW)

    expect(api.calls).toEqual([
      { method: 'showNoActivate', args: [OURS] },
      { method: 'seatAboveShell', args: [OURS] },
      { method: 'setTopmost', args: [OURS, true] },
      { method: 'isAbove', args: [OURS, FAKE_SHELL_WINDOW] }
    ])
    expect(api.callsTo('setTopmost')).toEqual([[OURS, true]])

    api.clearCalls()
    expect(api.calls).toEqual([])
  })

  it('starts with one app window above the shell window', () => {
    const api = createFakeWin32Api()

    expect(api.getShellWindow()).toBe(FAKE_SHELL_WINDOW)
    expect(api.zOrder).toEqual([FAKE_APP_WINDOW, FAKE_SHELL_WINDOW])
  })

  it('seats a window directly above the shell window, below every app', () => {
    const api = createFakeWin32Api()

    api.showNoActivate(OURS)
    expect(api.isShown(OURS)).toBe(true)
    api.seatAboveShell(OURS)

    expect(api.zOrder).toEqual([FAKE_APP_WINDOW, OURS, FAKE_SHELL_WINDOW])
    expect(api.isAbove(OURS, FAKE_SHELL_WINDOW)).toBe(true)
    expect(api.isAbove(FAKE_APP_WINDOW, OURS)).toBe(true)
  })

  it('raises a window into the topmost band and back out', () => {
    const api = createFakeWin32Api()
    api.seatAboveShell(OURS)

    api.setTopmost(OURS, true)
    expect(api.isTopmost(OURS)).toBe(true)
    expect(api.isAbove(OURS, FAKE_APP_WINDOW)).toBe(true)

    api.setTopmost(OURS, false)
    expect(api.isTopmostWindow(OURS)).toBe(false)
    api.seatAboveShell(OURS)
    expect(api.zOrder).toEqual([FAKE_APP_WINDOW, OURS, FAKE_SHELL_WINDOW])
  })

  it('simulates Win+D raising the shell window above the desktop windows', () => {
    const api = createFakeWin32Api()
    api.seatAboveShell(OURS)

    api.showDesktop()

    expect(api.isAbove(FAKE_SHELL_WINDOW, OURS)).toBe(true)
    expect(api.isAbove(FAKE_SHELL_WINDOW, FAKE_APP_WINDOW)).toBe(true)
  })

  it('simulates an Explorer restart with a new shell window handle', () => {
    const api = createFakeWin32Api()

    api.restartExplorer(null)
    expect(api.getShellWindow()).toBeNull()

    api.restartExplorer(0x7777n)
    expect(api.getShellWindow()).toBe(0x7777n)
    expect(api.zOrder.at(-1)).toBe(0x7777n)
  })

  it('exposes the live guard mode and lets a guarded window resist being raised', () => {
    const api = createFakeWin32Api()
    let mode: ZOrderMode = 'bottom'
    api.seatAboveShell(OURS)

    expect(api.installZOrderGuard(OURS, () => mode)).toBe(true)
    expect(api.guardMode(OURS)).toBe('bottom')

    api.raise(OURS)
    expect(api.zOrder).toEqual([FAKE_APP_WINDOW, OURS, FAKE_SHELL_WINDOW])

    mode = 'peek'
    expect(api.guardMode(OURS)).toBe('peek')
    api.raise(OURS)
    expect(api.isTopmostWindow(OURS)).toBe(true)

    api.removeZOrderGuard(OURS)
    api.removeZOrderGuard(OURS)
    expect(api.guardMode(OURS)).toBeNull()
  })

  it('lists the visible windows between two windows, skipping hidden ones', () => {
    const api = createFakeWin32Api()
    api.seatAboveShell(OURS)
    api.insertBelow(OTHER, OURS)
    api.insertBelow(0x5003n, OTHER)
    api.hideWindow(0x5003n)

    expect(api.zOrder).toEqual([FAKE_APP_WINDOW, OURS, OTHER, 0x5003n, FAKE_SHELL_WINDOW])
    expect(api.visibleWindowsBetween(OURS, FAKE_SHELL_WINDOW)).toEqual([OTHER])
    expect(api.visibleWindowsBetween(FAKE_APP_WINDOW, FAKE_SHELL_WINDOW)).toEqual([OURS, OTHER])
    expect(api.visibleWindowsBetween(FAKE_SHELL_WINDOW, OURS)).toEqual([])
  })

  it('sends setTopmost through the guard, like SetWindowPos through the real subclass proc', () => {
    const api = createFakeWin32Api()
    let mode: ZOrderMode = 'bottom'
    api.seatAboveShell(OURS)
    api.installZOrderGuard(OURS, () => mode)

    api.setTopmost(OURS, true)
    expect(api.isTopmost(OURS)).toBe(false)
    expect(api.zOrder).toEqual([FAKE_APP_WINDOW, OURS, FAKE_SHELL_WINDOW])

    mode = 'peek'
    api.setTopmost(OURS, false)
    expect(api.isTopmost(OURS)).toBe(true)
  })

  it('lets seatAboveShell stand the guard aside, as the real one does for its own move', () => {
    const api = createFakeWin32Api()
    api.setTopmost(OURS, true)
    api.installZOrderGuard(OURS, () => 'peek')

    api.seatAboveShell(OURS)

    expect(api.isTopmost(OURS)).toBe(false)
    expect(api.zOrder).toEqual([FAKE_APP_WINDOW, OURS, FAKE_SHELL_WINDOW])
  })

  it('raises an unguarded window to the top of the normal band', () => {
    const api = createFakeWin32Api()
    api.seatAboveShell(OTHER)

    api.raise(OTHER)

    expect(api.zOrder).toEqual([OTHER, FAKE_APP_WINDOW, FAKE_SHELL_WINDOW])
  })

  it('delivers foreground events until unsubscribed', () => {
    const api = createFakeWin32Api()
    const listener = vi.fn()

    const unsubscribe = api.watchForeground(listener)
    expect(api.foregroundListenerCount()).toBe(1)
    api.emitForeground(FAKE_SHELL_WINDOW)
    unsubscribe()
    api.emitForeground(FAKE_APP_WINDOW)

    expect(listener).toHaveBeenCalledExactlyOnceWith(FAKE_SHELL_WINDOW)
    expect(api.foregroundListenerCount()).toBe(0)
  })

  it('answers file attributes, registry strings, wallpapers and icons from configured data', () => {
    const api = createFakeWin32Api()

    expect(api.getFileAttributes('C:\\Users\\me\\Desktop\\desktop.ini')).toBeNull()
    expect(api.regGetString('HKCU', 'Control Panel\\Colors', 'Background')).toBeNull()
    expect(api.getWallpaperForMonitor({ x: 0, y: 0, width: 2560, height: 1440 })).toBeNull()
    expect(api.extractIcon('C:\\app.exe', 0, 64)).toBeNull()

    api.setFileAttributes('C:\\Users\\me\\Desktop\\desktop.ini', 0x6)
    api.setRegistryString('HKCU', 'Control Panel\\Colors', 'Background', '0 0 0')
    const wallpaper = { path: 'C:\\wall.jpg', position: 'fill' as const, monitorIndex: 0 }
    api.setWallpaper({ x: 0, y: 0, width: 2560, height: 1440 }, wallpaper)
    const icon = { width: 64, height: 64, bgra: Buffer.alloc(64 * 64 * 4), mask: null }
    api.setIcon('C:\\app.exe', 0, 64, icon)

    expect(api.getFileAttributes('c:\\users\\me\\desktop\\DESKTOP.INI')).toBe(0x6)
    expect(api.regGetString('HKCU', 'control panel\\colors', 'Background')).toBe('0 0 0')
    expect(api.getWallpaperForMonitor({ x: 0, y: 0, width: 2560, height: 1440 })).toBe(wallpaper)
    expect(api.extractIcon('C:\\APP.exe', 0, 64)).toBe(icon)
  })
})
