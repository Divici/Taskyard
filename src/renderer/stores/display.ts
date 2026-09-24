import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { DisplayInfo } from '@shared/ipc'

/** Why this window does not know its display. */
export type DisplayProblem =
  /** The URL has no `?displayId=` (the window was not opened by the desktop window manager). */
  | 'no-display-id'
  /** Main knows no display with that id (it was unplugged while the window loaded). */
  | 'unknown-display'
  /** Asking main failed (logged in the renderer console). */
  | 'fetch-failed'

/**
 * The monitor this desktop window covers, and whether Peek is on. Not persisted: main is the
 * source of truth and re-sends both (`display:changed`, `peek:changed`); src/renderer/lib/
 * display-sync.ts keeps this store in step.
 */
export interface DisplayState {
  /** From the window's URL; null when it has none. */
  displayId: number | null
  /** Bounds, work area and scale factor (DIPs, like Electron's `Display`); null until known. */
  info: DisplayInfo | null
  peeking: boolean
  problem: DisplayProblem | null
  setDisplayId(id: number | null): void
  /** Main's latest word on this display; copied, and clears any reported problem. */
  receiveInfo(info: DisplayInfo): void
  setPeeking(peeking: boolean): void
  reportProblem(problem: DisplayProblem): void
}

export function createDisplayStore(): UseBoundStore<StoreApi<DisplayState>> {
  return create<DisplayState>()((set) => ({
    displayId: null,
    info: null,
    peeking: false,
    problem: null,
    setDisplayId: (displayId) => set({ displayId }),
    receiveInfo: (info) => set({ info: structuredClone(info), problem: null }),
    setPeeking: (peeking) => set({ peeking }),
    reportProblem: (problem) => set({ problem })
  }))
}

export const useDisplayStore = createDisplayStore()
