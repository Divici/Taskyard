import { describe, expect, it } from 'vitest'
import type { Hwnd } from './api'
import { resolveShellWindow, type WindowTree } from './shell-window'

interface FakeWindow {
  hwnd: Hwnd
  className: string
  parent: Hwnd | null
}

/** A window tree listed in z-order (top first), queried the way FindWindowExW walks it. */
function fakeTree(windows: FakeWindow[], shellWindow: Hwnd | null): WindowTree {
  return {
    getShellWindow: () => shellWindow,
    findWindow: (parent, after, className) => {
      const siblings = windows.filter((w) => w.parent === parent && w.className === className)
      if (after === null) return siblings[0]?.hwnd ?? null
      const index = siblings.findIndex((w) => w.hwnd === after)
      return index < 0 ? null : (siblings[index + 1]?.hwnd ?? null)
    }
  }
}

const PROGMAN = 0x10n

describe('resolveShellWindow', () => {
  it('returns Progman when it hosts SHELLDLL_DefView (Windows 11 24H2 and later)', () => {
    const tree = fakeTree(
      [
        { hwnd: 0x20n, className: 'WorkerW', parent: null },
        { hwnd: PROGMAN, className: 'Progman', parent: null },
        { hwnd: 0x11n, className: 'SHELLDLL_DefView', parent: PROGMAN }
      ],
      PROGMAN
    )

    expect(resolveShellWindow(tree)).toBe(PROGMAN)
  })

  it('picks the WorkerW hosting SHELLDLL_DefView when the icons detached from Progman', () => {
    const hosting = 0x22n
    const tree = fakeTree(
      [
        { hwnd: 0x21n, className: 'WorkerW', parent: null },
        { hwnd: hosting, className: 'WorkerW', parent: null },
        { hwnd: 0x30n, className: 'SHELLDLL_DefView', parent: hosting },
        { hwnd: 0x23n, className: 'WorkerW', parent: null },
        { hwnd: PROGMAN, className: 'Progman', parent: null }
      ],
      PROGMAN
    )

    expect(resolveShellWindow(tree)).toBe(hosting)
  })

  it('falls back to Progman when no window hosts SHELLDLL_DefView yet', () => {
    const tree = fakeTree(
      [
        { hwnd: 0x21n, className: 'WorkerW', parent: null },
        { hwnd: PROGMAN, className: 'Progman', parent: null }
      ],
      PROGMAN
    )

    expect(resolveShellWindow(tree)).toBe(PROGMAN)
  })

  it('finds Progman by class when GetShellWindow returns nothing', () => {
    const tree = fakeTree([{ hwnd: PROGMAN, className: 'Progman', parent: null }], null)

    expect(resolveShellWindow(tree)).toBe(PROGMAN)
  })

  it('returns null while Explorer is not running', () => {
    expect(resolveShellWindow(fakeTree([], null))).toBeNull()
  })
})
