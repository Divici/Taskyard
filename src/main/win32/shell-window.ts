import type { Hwnd } from './api'
import { DEFVIEW_CLASS, PROGMAN_CLASS, WORKERW_CLASS } from './constants'

/** The two window-tree queries needed to find the desktop (injectable for tests). */
export interface WindowTree {
  /** `GetShellWindow()`: Progman, or null while Explorer is not running. */
  getShellWindow(): Hwnd | null
  /**
   * `FindWindowExW(parent, after, className, NULL)`: the next window of `className` after
   * `after` among the children of `parent` (top-level windows when `parent` is null).
   */
  findWindow(parent: Hwnd | null, after: Hwnd | null, className: string): Hwnd | null
}

/** Explorer creates a handful of WorkerW windows; this bounds a pathological walk. */
const MAX_WORKERW = 256

/**
 * The top-level window that hosts the desktop icons (`SHELLDLL_DefView`) — the window Win+D
 * raises and Taskyard must stay directly above. On Windows 11 24H2+ that is Progman itself;
 * after a wallpaper tool sends Progman 0x052C on older builds, the icons detach into a
 * top-level WorkerW. Falls back to Progman when no window hosts the icons yet.
 */
export function resolveShellWindow(tree: WindowTree): Hwnd | null {
  const progman = tree.getShellWindow() ?? tree.findWindow(null, null, PROGMAN_CLASS)
  if (progman !== null && tree.findWindow(progman, null, DEFVIEW_CLASS) !== null) return progman

  let workerW = tree.findWindow(null, null, WORKERW_CLASS)
  for (let seen = 0; workerW !== null && seen < MAX_WORKERW; seen++) {
    if (tree.findWindow(workerW, null, DEFVIEW_CLASS) !== null) return workerW
    workerW = tree.findWindow(null, workerW, WORKERW_CLASS)
  }
  return progman
}
