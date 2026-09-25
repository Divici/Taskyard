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
  it('names the page with a Taskyard heading inside the main landmark', async () => {
    await renderApp()

    const main = screen.getByRole('main')
    expect(main).toContainElement(screen.getByRole('heading', { level: 1, name: 'Taskyard' }))
  })

  it('renders the desktop canvas for its display, with the loose icons reconcile placed', async () => {
    const bridge = installFakeBridge(createFakeBridge({ items: [item] }))
    await renderApp(bridge)

    const icon = await screen.findByRole('option', { name: 'Budget' })
    expect(screen.getByRole('listbox', { name: 'Desktop icons' })).toContainElement(icon)
    expect(icon).toHaveStyle({ left: '0px', top: '0px' })
    await waitFor(() =>
      expect(bridge.storage.save).toHaveBeenCalledWith(
        'layout',
        expect.objectContaining({
          data: expect.objectContaining({ paths: { '3:4': item.path } })
        })
      )
    )
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

  it('lists the desktop from main (desktop:list) and shows the item count on its main landmark', async () => {
    const bridge = installFakeBridge(createFakeBridge({ items: [item] }))
    await renderApp(bridge)

    await waitFor(() => expect(useItemsStore.getState().hydrated).toBe(true))
    expect(useItemsStore.getState().byId['3:4']).toEqual(item)
    expect(bridge.desktop.list).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.getByRole('main')).toHaveAttribute('data-desktop-items', '1'))
  })

  it('places every desktop item on the primary display and shows it with the icon main sent (pulled, then streamed)', async () => {
    const folder: DesktopItem = { ...item, id: '3:5', name: 'Projects', ext: '', kind: 'folder' }
    const bridge = installFakeBridge(
      createFakeBridge({
        items: [item, folder],
        icons: [{ id: '3:4', px: 32, dataUrl: 'data:image/png;base64,SMALL', version: 'v1' }]
      })
    )
    await renderApp(bridge)

    const budget = await screen.findByRole('option', { name: 'Budget' })
    await waitFor(() =>
      expect(budget.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,SMALL')
    )
    act(() =>
      bridge.emit('desktop:icon', {
        id: '3:4',
        px: 96,
        dataUrl: 'data:image/png;base64,BIG',
        version: 'v1'
      })
    )

    expect(budget.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,BIG')
    expect(screen.getByRole('option', { name: 'Projects' }).querySelector('img')).toHaveAttribute(
      'data-icon',
      'generic'
    )
  })

  it('drops a stale icon: a new version replaces it, a clear shows the generic icon', async () => {
    const tool: DesktopItem = {
      ...item,
      id: '3:6',
      path: 'C:\\Users\\me\\Desktop\\tool.exe',
      name: 'tool',
      ext: '.exe',
      kind: 'app'
    }
    const link: DesktopItem = {
      ...item,
      id: '3:7',
      path: 'C:\\Users\\me\\Desktop\\Report.lnk',
      name: 'Report',
      ext: '.lnk',
      kind: 'link',
      targetPath: 'C:\\apps\\report.exe'
    }
    const bridge = installFakeBridge(createFakeBridge({ items: [tool, link] }))
    await renderApp(bridge)
    const img = (name: string): HTMLElement | null =>
      screen.getByRole('option', { name }).querySelector('img')
    await screen.findByRole('option', { name: 'tool' })
    act(() => {
      bridge.emit('desktop:icon', { id: '3:6', px: 96, dataUrl: 'data:exe', version: 'exe' })
      bridge.emit('desktop:icon', { id: '3:7', px: 96, dataUrl: 'data:app', version: 'lnk-1' })
    })

    // tool.exe renamed to tool.txt: main re-resolves and sends the text icon (32 px, new version).
    act(() => {
      bridge.emit('desktop:renamed', { id: '3:6', path: 'C:\\Users\\me\\Desktop\\tool.txt' })
      bridge.emit('desktop:icon', { id: '3:6', px: 32, dataUrl: 'data:txt', version: 'txt' })
    })
    expect(img('tool')).toHaveAttribute('src', 'data:txt')

    // Report.lnk retargeted from an exe to a pdf: the pdf icon (32 px) replaces the 96 px one.
    act(() => {
      bridge.emit('desktop:changed', {
        added: [],
        removed: [],
        changed: [{ ...link, targetPath: 'C:\\docs\\report.pdf', mtimeMs: 2 }]
      })
      bridge.emit('desktop:icon', { id: '3:7', px: 32, dataUrl: 'data:pdf', version: 'lnk-2' })
    })
    expect(img('Report')).toHaveAttribute('src', 'data:pdf')

    // The shortcut becomes a cloud placeholder: main clears its icon, the generic one shows.
    act(() => {
      bridge.emit('desktop:changed', {
        added: [],
        removed: [],
        changed: [{ ...link, placeholder: true, mtimeMs: 3 }]
      })
      bridge.emit('desktop:icon', { id: '3:7', px: 0, dataUrl: null, version: 'generic' })
    })
    expect(img('Report')).toHaveAttribute('data-icon', 'generic')
  })

  it('feeds the desktop events into the items store', async () => {
    const bridge = await renderApp()
    await waitFor(() => expect(useItemsStore.getState().hydrated).toBe(true))

    act(() => {
      bridge.emit('desktop:changed', { added: [item], removed: [], changed: [] })
      bridge.emit('desktop:renamed', {
        id: '3:4',
        path: 'C:\\Users\\me\\Desktop\\Budget 2026.xlsx'
      })
      bridge.emit('desktop:icon', {
        id: '3:4',
        px: 96,
        dataUrl: 'data:image/png;base64,AA',
        version: 'v1'
      })
    })

    expect(useItemsStore.getState().byId['3:4']).toMatchObject({ name: 'Budget 2026' })
    expect(useItemsStore.getState().icons['3:4']).toEqual({
      px: 96,
      dataUrl: 'data:image/png;base64,AA',
      version: 'v1'
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

  it("paints this display's wallpaper as its own layer, outside the content (quick-hide reveals it)", async () => {
    const bridge = await renderApp()

    const layer = await screen.findByTestId('wallpaper-layer')
    await waitFor(() => expect(bridge.wallpaper.get).toHaveBeenCalledWith(1))
    expect(screen.getByRole('main')).not.toContainElement(layer)
    // Painted first, so everything else stacks above it.
    expect(layer.compareDocumentPosition(screen.getByRole('main'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('themes the page from the settings and the Windows theme', async () => {
    const light = { ...defaultSettings(), theme: 'light' as const, glassBlur: 12 }
    const bridge = installFakeBridge(createFakeBridge({ files: { settings: light } }))
    await renderApp(bridge)

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
    expect(document.documentElement.style.getPropertyValue('--blur')).toBe('12px')

    act(() => useSettingsStore.getState().update({ theme: 'system' }))
    // The fake bridge's Windows is in dark mode.
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
  })

  it('unsubscribes from every event on unmount', async () => {
    const bridge = installFakeBridge()
    const { unmount } = render(<App />)
    await waitFor(() => expect(useTasksStore.getState().hydrated).toBe(true))

    unmount()

    for (const event of EVENT_CHANNELS) expect(bridge.listenerCount(event)).toBe(0)
  })
})
