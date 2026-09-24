import { act, render, screen, waitFor } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/defaults'
import { EVENT_CHANNELS } from '@shared/ipc'
import type { DesktopItem } from '@shared/schema'
import App from './App'
import { useDisplayStore } from './stores/display'
import { useItemsStore } from './stores/items'
import { useLayoutStore } from './stores/layout'
import { useSettingsStore } from './stores/settings'
import { useTasksStore } from './stores/tasks'
import { createFakeBridge, installFakeBridge, type FakeBridge } from './test/fake-bridge'

// Desktop windows load index.html?displayId=<id>; the fake bridge knows display 1.
const DISPLAY_ONE = {
  id: 1,
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1392 },
  scaleFactor: 1.5
}

beforeEach(() => {
  window.history.replaceState(null, '', '/?displayId=1')
})

async function renderApp(bridge: FakeBridge = installFakeBridge()): Promise<FakeBridge> {
  render(<App />)
  await waitFor(() => expect(useTasksStore.getState().hydrated).toBe(true))
  return bridge
}

const item: DesktopItem = {
  id: '3:4',
  path: 'C:\\Users\\me\\Desktop\\Budget.xlsx',
  name: 'Budget',
  ext: '.xlsx',
  kind: 'file',
  mtimeMs: 1,
  sizeBytes: 2048,
  readonly: false,
  placeholder: false
}

describe('App', () => {
  it('renders the Taskyard placeholder inside a main landmark', async () => {
    await renderApp()

    const main = screen.getByRole('main')
    expect(main).toContainElement(screen.getByRole('heading', { level: 1, name: 'Taskyard' }))
  })

  it('has no detectable accessibility violations', async () => {
    await renderApp()

    expect(await axe(document.body)).toHaveNoViolations()
  })

  it('hydrates the persisted stores from the bridge on mount', async () => {
    const dark = { ...defaultSettings(), theme: 'dark' as const }
    const bridge = installFakeBridge(createFakeBridge({ files: { settings: dark } }))

    await renderApp(bridge)

    expect(useSettingsStore.getState().settings).toEqual(dark)
    expect(useLayoutStore.getState().hydrated).toBe(true)
    expect(bridge.storage.load.mock.calls.map(([store]) => store).sort()).toEqual([
      'layout',
      'settings',
      'tasks'
    ])
  })

  it('shows a persistent read-only banner when main reports a file from a newer version', async () => {
    const bridge = installFakeBridge()
    bridge.storage.status.mockResolvedValue({
      readOnly: [{ store: 'layout', reason: 'future-version', version: 2 }],
      recovered: []
    })

    await renderApp(bridge)

    expect(await screen.findByRole('alert')).toHaveTextContent('Read-only mode')
  })

  it('shows a toast for a file recovered at startup', async () => {
    const bridge = installFakeBridge()
    bridge.storage.status.mockResolvedValue({
      readOnly: [],
      recovered: [
        {
          store: 'layout',
          restoredFrom: 'backup',
          reason: 'invalid',
          corruptPath: 'C:\\l.corrupt.json'
        }
      ]
    })

    await renderApp(bridge)

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Taskyard couldn’t read your desktop layout, so it restored the last backup.'
    )
  })

  it('shows a toast when storage:recovered arrives after startup', async () => {
    const bridge = await renderApp()

    act(() => {
      bridge.emit('storage:recovered', {
        store: 'tasks',
        restoredFrom: 'defaults',
        reason: 'unreadable-json',
        corruptPath: 'C:\\t.corrupt.json'
      })
    })

    expect(screen.getByRole('status')).toHaveTextContent(
      'Taskyard couldn’t read your tasks and timer and started fresh.'
    )
  })

  it('feeds the desktop events into the items store', async () => {
    const bridge = await renderApp()

    act(() => {
      bridge.emit('desktop:changed', { added: [item], removed: [], changed: [] })
      bridge.emit('desktop:renamed', {
        id: '3:4',
        path: 'C:\\Users\\me\\Desktop\\Budget 2026.xlsx'
      })
      bridge.emit('desktop:icon', { id: '3:4', px: 96, dataUrl: 'data:image/png;base64,AA' })
    })

    expect(useItemsStore.getState().byId['3:4']).toMatchObject({ name: 'Budget 2026' })
    expect(useItemsStore.getState().icons['3:4']).toEqual({
      px: 96,
      dataUrl: 'data:image/png;base64,AA'
    })
  })

  it('tells the page which display it covers, from main, on its main landmark', async () => {
    await renderApp()

    const main = screen.getByRole('main')
    await waitFor(() => expect(main).toHaveAttribute('data-display-id', '1'))
    expect(main).toHaveAttribute('data-scale-factor', '1.5')
    expect(main).toHaveAttribute('data-display-bounds', '0,0,2560,1440')
    expect(main).toHaveAttribute('data-peeking', 'false')
  })

  it('registers its display in the layout, and follows display:changed and peek:changed', async () => {
    const bridge = await renderApp()
    await waitFor(() => expect(useDisplayStore.getState().info).toEqual(DISPLAY_ONE))

    await waitFor(() =>
      expect(useLayoutStore.getState().layout.displays).toEqual([
        expect.objectContaining({ displayId: 1, bounds: DISPLAY_ONE.bounds })
      ])
    )
    act(() => {
      bridge.emit('display:changed', { ...DISPLAY_ONE, scaleFactor: 2 })
      bridge.emit('peek:changed', { peeking: true })
    })

    expect(screen.getByRole('main')).toHaveAttribute('data-scale-factor', '2')
    expect(screen.getByRole('main')).toHaveAttribute('data-peeking', 'true')
  })

  it('unsubscribes from every event on unmount', async () => {
    const bridge = installFakeBridge()
    const { unmount } = render(<App />)
    await waitFor(() => expect(useTasksStore.getState().hydrated).toBe(true))

    unmount()

    for (const event of EVENT_CHANNELS) expect(bridge.listenerCount(event)).toBe(0)
  })
})
