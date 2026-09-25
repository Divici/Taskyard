import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Hwnd, Win32Api } from './api'
import {
  FILE_ATTRIBUTE_DIRECTORY,
  FILE_ATTRIBUTE_HIDDEN,
  GW_HWNDPREV,
  HWND_TOP,
  HWND_TOPMOST,
  SPI_GETDESKWALLPAPER,
  SWP_NOACTIVATE,
  SWP_NOSIZE,
  SWP_NOZORDER,
  SWP_ZORDER_ONLY
} from './constants'
import type { Koffi } from './bindings'
import { loadWin32Bindings, type Win32Bindings } from './bindings'
import { createKoffiWin32Api } from './koffi-api'
import { realWin32TestsEnabled } from '../test/win32-opt-in'

const WS_POPUP = 0x80000000
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_NOACTIVATE = 0x08000000
const WS_VISIBLE = 0x10000000
const WS_EX_TOPMOST = 0x00000008
const SS_NOTIFY = 0x00000100
const SW_HIDE = 0
const DWMWA_CLOAK = 13
const MAX_PATH = 260

// Opt-in: npm run test:win32 (never part of npm test, never under TASKYARD_NO_WIN32=1).
describe.runIf(realWin32TestsEnabled())('createKoffiWin32Api (real Win32)', () => {
  let koffi: Koffi
  let api: Win32Api
  let b: Win32Bindings
  let createProbeWindow: (options?: { visibleOffscreen?: boolean }) => Hwnd
  let destroyWindow: (hwnd: Hwnd) => boolean
  let cloak: (hwnd: Hwnd, on: boolean) => void
  const log = { warn: vi.fn(), error: vi.fn() }
  const created: Hwnd[] = []
  let tmp: string

  beforeAll(async () => {
    koffi = (await import('koffi')).default
    b = loadWin32Bindings(koffi)
    api = createKoffiWin32Api(koffi, { log })
    const user32 = koffi.load('user32.dll')
    const createWindowEx = user32.func(
      'void * __stdcall CreateWindowExW(uint32 ex, str16 cls, str16 title, uint32 style, int x, int y, int w, int h, void *parent, void *menu, void *inst, void *param)'
    )
    const destroy = user32.func('int __stdcall DestroyWindow(void *hwnd)')
    destroyWindow = (hwnd) => destroy(hwnd) !== 0
    const setWindowAttribute = koffi
      .load('dwmapi.dll')
      .func(
        'long __stdcall DwmSetWindowAttribute(void *hwnd, uint32_t attr, int *value, uint32_t size)'
      )
    cloak = (hwnd, on) => void setWindowAttribute(hwnd, DWMWA_CLOAK, [on ? 1 : 0], 4)
    // A hidden 1x1 tool popup owned by this thread: SetWindowPos on it runs the subclass proc
    // synchronously, so the guard is exercised without a message pump and nothing is visible.
    // visibleOffscreen: a shown 10x10 window at -20000,-20000 counts as visible to Win32 while
    // nothing appears on any monitor.
    createProbeWindow = ({ visibleOffscreen = false } = {}) => {
      const hwnd = createWindowEx(
        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        'STATIC',
        'taskyard-koffi-api-test',
        visibleOffscreen ? WS_POPUP | WS_VISIBLE : WS_POPUP,
        visibleOffscreen ? -20000 : 0,
        visibleOffscreen ? -20000 : 0,
        visibleOffscreen ? 10 : 1,
        visibleOffscreen ? 10 : 1,
        null,
        null,
        null,
        null
      ) as Hwnd | null
      if (hwnd === null) throw new Error('CreateWindowExW failed')
      created.push(hwnd)
      return hwnd
    }
    // The first window a thread creates also creates the thread's Default IME window, and its
    // first z-order moves race that; later windows behave deterministically.
    createProbeWindow()
    tmp = mkdtempSync(join(tmpdir(), 'taskyard-koffi-'))
  })

  afterAll(() => {
    for (const hwnd of created) {
      api.removeZOrderGuard(hwnd)
      destroyWindow(hwnd)
    }
    rmSync(tmp, { recursive: true, force: true })
  })

  const directlyAboveShell = (hwnd: Hwnd): boolean => {
    const shell = api.getShellWindow()
    return shell !== null && b.GetWindow(shell, GW_HWNDPREV) === hwnd
  }
  // A process without foreground rights cannot HWND_TOP-raise its windows (SetWindowPos
  // succeeds but nothing moves), while HWND_TOPMOST always works: it is the raise tested here.
  const makeTopmost = (hwnd: Hwnd): void => {
    b.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_ZORDER_ONLY)
  }

  it('resolves the shell window that hosts the desktop icons', () => {
    const shell = api.getShellWindow()

    expect(shell).not.toBeNull()
    expect(b.FindWindowExW(shell, null, 'SHELLDLL_DefView', null)).not.toBeNull()
    expect(api.isAbove(shell!, shell!)).toBe(false)
  })

  it('seats a window directly above the shell window, leaving the topmost band', () => {
    const hwnd = createProbeWindow()
    makeTopmost(hwnd)
    expect(b.isTopmost(hwnd)).toBe(true)

    api.seatAboveShell(hwnd)

    expect(directlyAboveShell(hwnd)).toBe(true)
    expect(b.isTopmost(hwnd)).toBe(false)
    expect(api.isAbove(hwnd, api.getShellWindow()!)).toBe(true)
    expect(api.isAbove(api.getShellWindow()!, hwnd)).toBe(false)
  })

  it('keeps a guarded window seated when it is raised, and lets it go topmost only in peek mode', () => {
    const hwnd = createProbeWindow()
    let mode: 'bottom' | 'peek' = 'bottom'
    api.seatAboveShell(hwnd)
    expect(api.installZOrderGuard(hwnd, () => mode)).toBe(true)

    makeTopmost(hwnd)
    expect(b.isTopmost(hwnd)).toBe(false)
    expect(directlyAboveShell(hwnd)).toBe(true)

    mode = 'peek'
    b.SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_ZORDER_ONLY)
    expect(b.isTopmost(hwnd)).toBe(true)

    mode = 'bottom'
    api.setTopmost(hwnd, false)
    expect(b.isTopmost(hwnd)).toBe(false)
    expect(directlyAboveShell(hwnd)).toBe(true)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('leaves moves that carry SWP_NOZORDER alone', () => {
    const hwnd = createProbeWindow()
    makeTopmost(hwnd)
    api.installZOrderGuard(hwnd, () => 'bottom')

    b.SetWindowPos(hwnd, HWND_TOP, 5, 5, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)

    expect(b.isTopmost(hwnd)).toBe(true)
    api.seatAboveShell(hwnd)
    expect(directlyAboveShell(hwnd)).toBe(true)
  })

  it('stops guarding once the guard is removed (twice is harmless)', () => {
    const hwnd = createProbeWindow()
    api.seatAboveShell(hwnd)
    api.installZOrderGuard(hwnd, () => 'bottom')

    api.removeZOrderGuard(hwnd)
    api.removeZOrderGuard(hwnd)
    makeTopmost(hwnd)

    expect(b.isTopmost(hwnd)).toBe(true)
    api.seatAboveShell(hwnd)
  })

  it('finds the top-level window under the cursor (Phase 8 drag-out)', () => {
    const point = { x: 0, y: 0 }
    expect(b.GetCursorPos(point)).toBe(true)
    // A visible topmost 24x24 popup centred on the cursor (SS_NOTIFY: a static control is
    // otherwise transparent to hit testing), briefly on screen.
    const user32 = koffi.load('user32.dll')
    const createWindowEx = user32.func(
      'void * __stdcall CreateWindowExW(uint32 ex, str16 cls, str16 title, uint32 style, int x, int y, int w, int h, void *parent, void *menu, void *inst, void *param)'
    )
    const hwnd = createWindowEx(
      WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
      'STATIC',
      'taskyard-cursor-probe',
      WS_POPUP | WS_VISIBLE | SS_NOTIFY,
      point.x - 12,
      point.y - 12,
      24,
      24,
      null,
      null,
      null,
      null
    ) as Hwnd | null
    expect(hwnd).not.toBeNull()
    created.push(hwnd!)

    expect(api.rootWindowAtCursor()).toBe(hwnd)
    // Nobody holds a mouse button while the suite runs.
    expect(api.isPrimaryButtonDown()).toBe(false)
  })

  it('lists the visible, uncloaked windows between a window and the shell window', () => {
    const seated = createProbeWindow()
    api.seatAboveShell(seated)
    const shell = api.getShellWindow()!
    const intruder = createProbeWindow({ visibleOffscreen: true })
    const hidden = createProbeWindow()
    b.SetWindowPos(intruder, Number(seated), 0, 0, 0, 0, SWP_ZORDER_ONLY)
    b.SetWindowPos(hidden, Number(intruder), 0, 0, 0, 0, SWP_ZORDER_ONLY)

    expect(api.visibleWindowsBetween(seated, shell)).toEqual([intruder])
    expect(api.visibleWindowsBetween(shell, seated)).toEqual([])

    cloak(intruder, true)
    expect(api.visibleWindowsBetween(seated, shell)).toEqual([])
    cloak(intruder, false)
    b.ShowWindow(intruder, SW_HIDE)
    expect(api.visibleWindowsBetween(seated, shell)).toEqual([])
  })

  it('reports WS_EX_TOPMOST', () => {
    const hwnd = createProbeWindow()

    makeTopmost(hwnd)
    expect(api.isTopmost(hwnd)).toBe(true)
    api.seatAboveShell(hwnd)
    expect(api.isTopmost(hwnd)).toBe(false)
  })

  it('removes the guard when the window is destroyed (WM_NCDESTROY)', () => {
    const hwnd = createProbeWindow()
    api.installZOrderGuard(hwnd, () => 'bottom')

    expect(destroyWindow(hwnd)).toBe(true)
    created.splice(created.indexOf(hwnd), 1)

    // The guard is gone, so removing it again makes no RemoveWindowSubclass call on a dead HWND.
    const remove = vi.spyOn(b, 'RemoveWindowSubclass')
    api.removeZOrderGuard(hwnd)
    expect(remove).not.toHaveBeenCalled()
    remove.mockRestore()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('shows a hidden window without activating it', () => {
    const hwnd = createProbeWindow()

    api.showNoActivate(hwnd)

    expect(b.IsWindowVisible(hwnd)).toBe(true)
    b.ShowWindow(hwnd, SW_HIDE)
  })

  it('enumerates top-level windows in z-order through the EnumWindows callback', () => {
    const hwnd = createProbeWindow()
    api.seatAboveShell(hwnd)
    const windows = b.enumWindows()
    const shell = api.getShellWindow()!

    expect(windows.length).toBeGreaterThan(10)
    expect(windows.indexOf(hwnd)).toBeGreaterThanOrEqual(0)
    expect(windows.indexOf(hwnd)).toBeLessThan(windows.indexOf(shell))
  })

  it('reads the wallpaper path with SystemParametersInfoW (used from Phase 6)', () => {
    const buffer = Buffer.alloc(MAX_PATH * 2)

    expect(b.SystemParametersInfoW(SPI_GETDESKWALLPAPER, MAX_PATH, buffer, 0)).toBe(true)
    const path = buffer.toString('utf16le').split(String.fromCharCode(0))[0]
    // Empty for a solid-colour desktop, else a drive or UNC path.
    expect(path === '' || /^([A-Za-z]:|\\\\)/.test(path)).toBe(true)
  })

  it('subscribes to foreground changes with an idempotent unsubscribe', () => {
    const unsubscribe = api.watchForeground(() => {})

    unsubscribe()
    expect(() => unsubscribe()).not.toThrow()
  })

  it('reads file attributes through \\\\?\\ paths, including paths past MAX_PATH', () => {
    const deepDir = join(tmp, 'a'.repeat(100), 'b'.repeat(100), 'c'.repeat(100))
    mkdirSync(deepDir, { recursive: true })
    const deepFile = join(deepDir, 'hidden.txt')
    writeFileSync(deepFile, 'x')
    expect(deepFile.length).toBeGreaterThan(260)
    const hiddenFile = join(tmp, 'hidden.txt')
    writeFileSync(hiddenFile, 'x')
    spawnSync('attrib', ['+h', hiddenFile])

    expect(api.getFileAttributes(tmp)! & FILE_ATTRIBUTE_DIRECTORY).toBe(FILE_ATTRIBUTE_DIRECTORY)
    expect(api.getFileAttributes(hiddenFile)! & FILE_ATTRIBUTE_HIDDEN).toBe(FILE_ATTRIBUTE_HIDDEN)
    expect(api.getFileAttributes(deepFile)).not.toBeNull()
    expect(api.getFileAttributes(join(tmp, 'missing.txt'))).toBeNull()
  })

  it('reads REG_SZ values, expands REG_EXPAND_SZ values and returns null when missing', () => {
    const product = api.regGetString(
      'HKLM',
      'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion',
      'ProductName'
    )
    expect(product).toMatch(/^Windows /)

    const temp = api.regGetString('HKCU', 'Environment', 'TEMP')
    expect(temp).toBeTruthy()
    expect(temp).not.toContain('%')

    expect(api.regGetString('HKCU', 'Environment', 'TASKYARD_NO_SUCH_VALUE')).toBeNull()
    expect(api.regGetString('HKCU', 'Software\\Taskyard\\NoSuchKey', 'x')).toBeNull()
  })

  it('canModifyFolder: a writable temp folder yes, a missing one no, and no side effects', () => {
    const dir = join(tmp, 'writable')
    mkdirSync(dir)

    expect(api.canModifyFolder(dir)).toBe(true)
    expect(api.canModifyFolder(join(tmp, 'no-such-folder'))).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('canModifyFolder honours an ACL that denies adding files (fs.access W_OK would not)', () => {
    const dir = join(tmp, 'denied')
    mkdirSync(dir)
    const user = `${process.env['USERDOMAIN']}\\${process.env['USERNAME']}`
    const deny = spawnSync('icacls', [dir, '/deny', `${user}:(WD,AD,DC)`], { encoding: 'utf8' })
    expect(deny.status, deny.stdout + deny.stderr).toBe(0)
    try {
      expect(api.canModifyFolder(dir)).toBe(false)
      // Node's check ignores ACLs on Windows, which is why Taskyard does not use it (R13).
      expect(() => accessSync(dir, constants.W_OK)).not.toThrow()
      expect(readdirSync(dir)).toEqual([])
    } finally {
      spawnSync('icacls', [dir, '/remove:d', user])
    }
    expect(api.canModifyFolder(dir)).toBe(true)
  })

  it('moveFile never replaces an existing file and keeps the file id', () => {
    const dir = join(tmp, 'move')
    mkdirSync(dir)
    writeFileSync(join(dir, 'a.txt'), 'A')
    writeFileSync(join(dir, 'b.txt'), 'B')
    const id = statSync(join(dir, 'a.txt'), { bigint: true }).ino

    expect(() => api.moveFile(join(dir, 'a.txt'), join(dir, 'b.txt'))).toThrow(
      expect.objectContaining({ code: 'EEXIST' })
    )
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('B')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('A')

    api.moveFile(join(dir, 'a.txt'), join(dir, 'renamed.txt'))
    expect(statSync(join(dir, 'renamed.txt'), { bigint: true }).ino).toBe(id)

    // A case-only rename of the same file goes through.
    api.moveFile(join(dir, 'renamed.txt'), join(dir, 'Renamed.TXT'))
    expect(readdirSync(dir).sort()).toEqual(['Renamed.TXT', 'b.txt'])

    expect(() => api.moveFile(join(dir, 'missing.txt'), join(dir, 'x.txt'))).toThrow(
      expect.objectContaining({ code: 'ENOENT' })
    )
  })

  it('moveFile works on paths past MAX_PATH', () => {
    const deepDir = join(tmp, 'd'.repeat(120), 'e'.repeat(120))
    mkdirSync(deepDir, { recursive: true })
    const from = join(deepDir, 'long-name-source.txt')
    writeFileSync(from, 'x')
    const to = join(deepDir, 'long-name-target.txt')
    expect(to.length).toBeGreaterThan(260)

    api.moveFile(from, to)

    expect(readdirSync(deepDir)).toEqual(['long-name-target.txt'])
  })

  it('setHidden sets and clears FILE_ATTRIBUTE_HIDDEN', () => {
    const file = join(tmp, 'to-hide.txt')
    writeFileSync(file, 'x')

    expect(api.setHidden(file, true)).toBe(true)
    expect(api.getFileAttributes(file)! & FILE_ATTRIBUTE_HIDDEN).toBe(FILE_ATTRIBUTE_HIDDEN)
    expect(api.setHidden(file, false)).toBe(true)
    expect(api.getFileAttributes(file)! & FILE_ATTRIBUTE_HIDDEN).toBe(0)
    expect(api.setHidden(join(tmp, 'missing.txt'), true)).toBe(false)
  })

  it('reads the wallpaper of the monitor at (0, 0) through IDesktopWallpaper (Phase 6)', () => {
    // A 1×1 rect inside the primary monitor matches it by overlap.
    const wallpaper = api.getWallpaperForMonitor({ x: 0, y: 0, width: 1, height: 1 })
    expect(wallpaper).not.toBeNull()
    expect(['center', 'tile', 'stretch', 'fit', 'fill', 'span']).toContain(wallpaper!.position)
    expect(wallpaper!.monitorIndex).toBeGreaterThanOrEqual(0)
  })
})
