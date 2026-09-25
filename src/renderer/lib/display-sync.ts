import type { StoreApi } from 'zustand'
import type { DisplayInfo } from '@shared/ipc'
import type { TaskyardApi } from '../../preload/api'
import { useDisplayStore, type DisplayState } from '../stores/display'
import { useLayoutStore, type LayoutState } from '../stores/layout'
import { parseDisplayId } from './display-id'
import { initialToolsPlacement } from './tools-placement'

export interface DisplaySyncTargets {
  display: Pick<StoreApi<DisplayState>, 'getState'>
  layout: { getState(): Pick<LayoutState, 'ensureDisplay'> }
}

const APP_TARGETS: DisplaySyncTargets = { display: useDisplayStore, layout: useLayoutStore }

/**
 * Connects this window to the monitor it covers: reads its display id from the URL
 * (`?displayId=`, set by the desktop window manager), asks main for that display, and follows
 * `display:changed` (bounds, work area, scale factor) and `peek:changed`.
 *
 * Every display main describes is registered in the layout (`ensureDisplay`) — here, and only
 * here. Never in reaction to a layout change: each window's own save is echoed back to it, so a
 * layout-driven `ensureDisplay` would save again on every echo, in every window, forever.
 *
 * Returns the disconnect (listeners removed; a late answer from main is ignored).
 */
export function connectDisplay(
  api: Pick<TaskyardApi, 'display' | 'on'>,
  search: string,
  targets: DisplaySyncTargets = APP_TARGETS
): () => void {
  const display = (): DisplayState => targets.display.getState()
  let connected = true
  /** A display:changed came first: it is at least as new as the answer still in flight. */
  let eventSeen = false

  const displayId = parseDisplayId(search)
  display().setDisplayId(displayId)

  const apply = (info: DisplayInfo): void => {
    display().receiveInfo(info)
    targets.layout.getState().ensureDisplay({
      id: info.id,
      bounds: info.bounds,
      // Phase 10: only used if this display has no layout entry yet.
      tools: initialToolsPlacement(info)
    })
  }

  const unsubscribers = [
    api.on('display:changed', (info) => {
      if (info.id !== displayId) {
        console.warn(
          `display: ignoring display:changed for display ${info.id} (this window covers ${displayId})`
        )
        return
      }
      eventSeen = true
      apply(info)
    }),
    api.on('peek:changed', ({ peeking }) => display().setPeeking(peeking))
  ]

  if (displayId === null) {
    console.error(`display: this window's URL has no display id (${search || 'empty query'})`)
    display().reportProblem('no-display-id')
  } else {
    api.display.get(displayId).then(
      (info) => {
        if (!connected || eventSeen) return
        if (info === null) {
          console.error(`display: main knows no display ${displayId}`)
          display().reportProblem('unknown-display')
          return
        }
        apply(info)
      },
      (error: unknown) => {
        if (!connected) return
        console.error(`display: asking main for display ${displayId} failed`, error)
        display().reportProblem('fetch-failed')
      }
    )
  }

  return () => {
    connected = false
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}
