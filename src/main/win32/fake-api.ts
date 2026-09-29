import { existsSync, renameSync, statSync } from 'node:fs'
import { DRIVE_FIXED, FILE_ATTRIBUTE_HIDDEN } from './constants'
import type {
  Hwnd,
  IconBitmap,
  MonitorWallpaper,
  PixelRect,
  RegistryHive,
  Unsubscribe,
  Win32Api,
  ZOrderMode
} from './api'

/** The fake's initial shell desktop window (Progman). */
export const FAKE_SHELL_WINDOW = 0x10010n
/** The fake's initial ordinary app window, above the shell window. */
export const FAKE_APP_WINDOW = 0x20020n
/** The fake's taskbar (Shell_TrayWnd): part of the tray for `isTrayWindow`. */
export const FAKE_TASKBAR_WINDOW = 0x30030n
/** The fake's own tray icon host window (Electron_NotifyIconHostWindow in Taskyard's process). */
export const FAKE_TRAY_HOST_WINDOW = 0x40040n

export interface FakeCall {
  method: keyof Win32Api
  args: unknown[]
}

/**
 * A `Win32Api` that records every call and keeps an in-memory z-order: a top-first list with a
 * topmost band at its head. Used by unit tests and by the app under `TASKYARD_NO_WIN32=1`.
 */
export interface FakeWin32Api extends Win32Api {
  readonly calls: readonly FakeCall[]
  callsTo(method: keyof Win32Api): unknown[][]
  clearCalls(): void
  /** Modelled windows, top of the z-order first (the shell window included). */
  readonly zOrder: readonly Hwnd[]
  isTopmostWindow(hwnd: Hwnd): boolean
  isShown(hwnd: Hwnd): boolean
  /** The mode the window's guard enforces right now, or null without a guard. */
  guardMode(hwnd: Hwnd): ZOrderMode | null
  /** A click or activation asking to bring `hwnd` forward; a guard decides where it lands. */
  raise(hwnd: Hwnd): void
  /** Puts `hwnd` directly below `reference` (Explorer restoring a window after Win+D). */
  insertBelow(hwnd: Hwnd, reference: Hwnd): void
  /** Makes `hwnd` invisible to `visibleWindowsBetween` (hidden, minimized or cloaked). */
  hideWindow(hwnd: Hwnd): void
  /** Something outside Taskyard (and its guard) leaves `hwnd` stuck in the topmost band. */
  forceTopmost(hwnd: Hwnd): void
  /** Win+D: the shell window moves to the top of the normal band. */
  showDesktop(): void
  /** Explorer restarted: the old shell window is gone; `shell` (if any) is new, at the bottom. */
  restartExplorer(shell: Hwnd | null): void
  emitForeground(hwnd: Hwnd | null): void
  foregroundListenerCount(): number
  setFileAttributes(path: string, attributes: number): void
  /** What `canModifyFolder(dir)` answers (every folder is writable until told otherwise). */
  setFolderWritable(dir: string, writable: boolean): void
  setRegistryString(hive: RegistryHive, key: string, value: string, data: string): void
  setWallpaper(rectPx: PixelRect, wallpaper: MonitorWallpaper): void
  setIcon(file: string, index: number, px: number, icon: IconBitmap): void
  /** What `getDriveType(root)` answers (`DRIVE_FIXED` unless told otherwise). */
  setDriveType(root: string, type: number): void
  /** What `rootWindowAtCursor()` answers (null until told). */
  setWindowAtCursor(hwnd: Hwnd | null): void
  /** What `isPrimaryButtonDown()` answers (up until told). */
  setPrimaryButtonDown(down: boolean): void
}

export interface FakeWin32ApiOptions {
  shellWindow?: Hwnd | null
}

/** Windows paths and registry keys compare case-insensitively (NTFS upcase convention). */
const keyOf = (...parts: (string | number)[]): string => parts.join('|').toUpperCase()
const rectKey = (rect: PixelRect): string => keyOf(rect.x, rect.y, rect.width, rect.height)

export function createFakeWin32Api(options: FakeWin32ApiOptions = {}): FakeWin32Api {
  const calls: FakeCall[] = []
  let shell: Hwnd | null =
    options.shellWindow === undefined ? FAKE_SHELL_WINDOW : options.shellWindow
  let zOrder: Hwnd[] = shell === null ? [FAKE_APP_WINDOW] : [FAKE_APP_WINDOW, shell]
  const topmost = new Set<Hwnd>()
  const shown = new Set<Hwnd>()
  const hidden = new Set<Hwnd>()
  const guards = new Map<Hwnd, () => ZOrderMode>()
  const foregroundListeners = new Set<(hwnd: Hwnd | null) => void>()
  const attributes = new Map<string, number>()
  const readOnlyFolders = new Set<string>()
  const registry = new Map<string, string>()
  const wallpapers = new Map<string, MonitorWallpaper>()
  const icons = new Map<string, IconBitmap>()
  const driveTypes = new Map<string, number>()
  /** The last window emitForeground reported (what foregroundWindow answers). */
  let foreground: Hwnd | null = null
  let windowAtCursor: Hwnd | null = null
  let primaryButtonDown = false

  const record = (method: keyof Win32Api, args: unknown[]): void => {
    calls.push({ method, args })
  }

  const without = (hwnd: Hwnd): Hwnd[] => zOrder.filter((h) => h !== hwnd)
  const normalBandStart = (order: Hwnd[]): number => order.filter((h) => topmost.has(h)).length

  const placeAt = (hwnd: Hwnd, index: (order: Hwnd[]) => number): void => {
    const order = without(hwnd)
    order.splice(index(order), 0, hwnd)
    zOrder = order
  }
  const toTopmost = (hwnd: Hwnd): void => {
    topmost.add(hwnd)
    placeAt(hwnd, () => 0)
  }
  const toNormalTop = (hwnd: Hwnd): void => {
    topmost.delete(hwnd)
    placeAt(hwnd, normalBandStart)
  }
  const toAboveShell = (hwnd: Hwnd): void => {
    topmost.delete(hwnd)
    placeAt(hwnd, (order) => (shell === null ? order.length : order.indexOf(shell)))
  }
  /** Where the guard sends any z-order change of `hwnd` (the real WM_WINDOWPOSCHANGING rewrite). */
  const guarded = (hwnd: Hwnd, mode: () => ZOrderMode): void => {
    if (mode() === 'peek') toTopmost(hwnd)
    else toAboveShell(hwnd)
  }

  return {
    get calls() {
      return calls
    },
    callsTo: (method) => calls.filter((call) => call.method === method).map((call) => call.args),
    clearCalls: () => {
      calls.length = 0
    },
    get zOrder() {
      return zOrder
    },
    isTopmostWindow: (hwnd) => topmost.has(hwnd),
    isShown: (hwnd) => shown.has(hwnd),
    guardMode: (hwnd) => guards.get(hwnd)?.() ?? null,

    raise(hwnd) {
      const guard = guards.get(hwnd)
      if (guard === undefined) toNormalTop(hwnd)
      else guarded(hwnd, guard)
    },
    insertBelow(hwnd, reference) {
      placeAt(hwnd, (order) => order.indexOf(reference) + 1)
    },
    hideWindow: (hwnd) => hidden.add(hwnd),
    forceTopmost: (hwnd) => toTopmost(hwnd),
    showDesktop() {
      if (shell !== null) toNormalTop(shell)
    },
    restartExplorer(next) {
      if (shell !== null) zOrder = without(shell)
      shell = next
      if (next !== null) zOrder = [...without(next), next]
    },
    emitForeground(hwnd) {
      foreground = hwnd
      for (const listener of [...foregroundListeners]) listener(hwnd)
    },
    foregroundListenerCount: () => foregroundListeners.size,
    setFileAttributes: (path, value) => attributes.set(keyOf(path), value),
    setFolderWritable: (dir, writable) => {
      if (writable) readOnlyFolders.delete(keyOf(dir))
      else readOnlyFolders.add(keyOf(dir))
    },
    setRegistryString: (hive, key, value, data) => registry.set(keyOf(hive, key, value), data),
    setWallpaper: (rect, wallpaper) => wallpapers.set(rectKey(rect), wallpaper),
    setIcon: (file, index, px, icon) => icons.set(keyOf(file, index, px), icon),
    setDriveType: (root, type) => driveTypes.set(keyOf(root), type),

    setWindowAtCursor: (hwnd) => {
      windowAtCursor = hwnd
    },
    setPrimaryButtonDown: (down) => {
      primaryButtonDown = down
    },

    seatAboveShell(hwnd) {
      record('seatAboveShell', [hwnd])
      // The real guard stands aside while seatAboveShell makes its own move.
      toAboveShell(hwnd)
    },
    setTopmost(hwnd, on) {
      record('setTopmost', [hwnd, on])
      const guard = guards.get(hwnd)
      if (guard !== undefined) guarded(hwnd, guard)
      else if (on) toTopmost(hwnd)
      else toNormalTop(hwnd)
    },
    showNoActivate(hwnd) {
      record('showNoActivate', [hwnd])
      shown.add(hwnd)
      if (!zOrder.includes(hwnd)) toNormalTop(hwnd)
    },
    installZOrderGuard(hwnd, mode) {
      record('installZOrderGuard', [hwnd, mode])
      guards.set(hwnd, mode)
      return true
    },
    removeZOrderGuard(hwnd) {
      record('removeZOrderGuard', [hwnd])
      guards.delete(hwnd)
    },
    watchForeground(cb): Unsubscribe {
      record('watchForeground', [cb])
      foregroundListeners.add(cb)
      return () => {
        foregroundListeners.delete(cb)
      }
    },
    getShellWindow() {
      record('getShellWindow', [])
      return shell
    },
    isTrayWindow(hwnd) {
      record('isTrayWindow', [hwnd])
      return hwnd === FAKE_TASKBAR_WINDOW || hwnd === FAKE_TRAY_HOST_WINDOW
    },
    isAbove(a, b) {
      record('isAbove', [a, b])
      const indexA = zOrder.indexOf(a)
      const indexB = zOrder.indexOf(b)
      return indexA >= 0 && indexB >= 0 && indexA < indexB
    },
    isTopmost(hwnd) {
      record('isTopmost', [hwnd])
      return topmost.has(hwnd)
    },
    visibleWindowsBetween(upper, lower) {
      record('visibleWindowsBetween', [upper, lower])
      const top = zOrder.indexOf(upper)
      const bottom = zOrder.indexOf(lower)
      if (top < 0 || bottom <= top) return []
      return zOrder.slice(top + 1, bottom).filter((hwnd) => !hidden.has(hwnd))
    },
    getFileAttributes(path) {
      record('getFileAttributes', [path])
      return attributes.get(keyOf(path)) ?? null
    },
    canModifyFolder(dir) {
      record('canModifyFolder', [dir])
      return !readOnlyFolders.has(keyOf(dir))
    },
    moveFile(from, to) {
      record('moveFile', [from, to])
      moveWithoutReplacing(from, to)
    },
    setHidden(path, hidden) {
      record('setHidden', [path, hidden])
      const current = attributes.get(keyOf(path)) ?? 0
      attributes.set(
        keyOf(path),
        hidden ? current | FILE_ATTRIBUTE_HIDDEN : current & ~FILE_ATTRIBUTE_HIDDEN
      )
      return true
    },
    regGetString(hive, key, value) {
      record('regGetString', [hive, key, value])
      return registry.get(keyOf(hive, key, value)) ?? null
    },
    getWallpaperForMonitor(rectPx) {
      record('getWallpaperForMonitor', [rectPx])
      return wallpapers.get(rectKey(rectPx)) ?? null
    },
    rootWindowAtCursor() {
      record('rootWindowAtCursor', [])
      return windowAtCursor
    },
    allowSetForegroundWindow(pid) {
      record('allowSetForegroundWindow', [pid])
      return true
    },
    cancelMenu(owner) {
      record('cancelMenu', [owner])
      return true
    },
    foregroundWindow() {
      record('foregroundWindow', [])
      return foreground
    },
    desktopViewCommand(command) {
      record('desktopViewCommand', [command])
      return true
    },
    isPrimaryButtonDown() {
      record('isPrimaryButtonDown', [])
      return primaryButtonDown
    },
    getDriveType(root) {
      record('getDriveType', [root])
      return driveTypes.get(keyOf(root)) ?? DRIVE_FIXED
    },
    extractIcon(file, index, px) {
      record('extractIcon', [file, index, px])
      return icons.get(keyOf(file, index, px)) ?? null
    }
  }
}

function fsError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

/**
 * MoveFileExW without MOVEFILE_REPLACE_EXISTING, on the real file system (the fake is used by
 * headless tests over temp folders, and by the app under TASKYARD_NO_WIN32=1): refuses an
 * existing target unless it is the same file (a case-only rename). `renameSync` fails with
 * EXDEV across volumes, as MoveFileExW does without MOVEFILE_COPY_ALLOWED.
 */
function moveWithoutReplacing(from: string, to: string): void {
  if (!existsSync(from)) throw fsError('ENOENT', `no such file, move '${from}' -> '${to}'`)
  if (existsSync(to)) {
    const a = statSync(from, { bigint: true })
    const b = statSync(to, { bigint: true })
    if (a.dev !== b.dev || a.ino !== b.ino) {
      throw fsError('EEXIST', `file already exists, move '${from}' -> '${to}'`)
    }
  }
  renameSync(from, to)
}
