import { join } from 'node:path'
import { format, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { desktopWindowUrl } from '../windows/desktop-window'
import { FakeIpcMain } from './fake-ipc-main'
import { createSenderGuard, handleTrusted } from './sender-guard'

const rendererFile = join(
  'C:\\Program Files\\Taskyard\\resources\\app.asar',
  'out',
  'renderer',
  'index.html'
)
const rendererUrl = pathToFileURL(rendererFile).href

function frame(url: string | null): {
  sender: { id: number }
  senderFrame: { url: string } | null
} {
  return { sender: { id: 1 }, senderFrame: url === null ? null : { url } }
}

describe('createSenderGuard', () => {
  const guard = createSenderGuard({ rendererFile })

  it('trusts the packaged renderer page, with or without a query', () => {
    expect(guard(frame(rendererUrl))).toBe(true)
    expect(guard(frame(`${rendererUrl}?displayId=2528732444`))).toBe(true)
    expect(guard(frame(`${rendererUrl}#settings`))).toBe(true)
  })

  it('compares the path case-insensitively, as NTFS does', () => {
    expect(guard(frame(rendererUrl.toUpperCase().replace('FILE:', 'file:')))).toBe(true)
  })

  it('rejects any other file, any web page and a missing frame', () => {
    const other = pathToFileURL(join('C:\\Users\\me\\Downloads', 'index.html')).href

    expect(guard(frame(other))).toBe(false)
    expect(guard(frame('https://evil.example/index.html'))).toBe(false)
    expect(guard(frame('about:blank'))).toBe(false)
    expect(guard(frame('not a url'))).toBe(false)
    expect(guard(frame(null))).toBe(false)
  })

  it('trusts the dev server origin only when one is configured', () => {
    const dev = createSenderGuard({ rendererFile, devServerUrl: 'http://localhost:5173' })

    expect(dev(frame('http://localhost:5173/?displayId=1'))).toBe(true)
    expect(dev(frame('http://localhost:51730/'))).toBe(false)
    expect(dev(frame('http://127.0.0.1:5173/'))).toBe(false)
    expect(guard(frame('http://localhost:5173/'))).toBe(false)
  })
})

describe('the desktop windows as senders', () => {
  const DISPLAY_ID = 2450156880
  const builtRenderer = join('C:\\Users\\me\\Taskyard', 'out', 'renderer', 'index.html')
  const guard = createSenderGuard({ rendererFile: builtRenderer })

  it('trusts a desktop window loaded from the built index.html with its ?displayId= query', () => {
    // What BrowserWindow.loadFile(path, {query}) navigates to (Electron formats it this way) …
    const loadFileUrl = format({
      protocol: 'file',
      slashes: true,
      pathname: builtRenderer,
      query: { displayId: String(DISPLAY_ID) }
    })
    // … and the canonical URL Chromium then reports as the sender frame's URL.
    const frameUrl = new URL(loadFileUrl).href

    expect(frameUrl).toBe(
      `file:///C:/Users/me/Taskyard/out/renderer/index.html?displayId=${DISPLAY_ID}`
    )
    expect(guard(frame(frameUrl))).toBe(true)
  })

  it('trusts a desktop window on the dev server URL the manager builds, only in dev', () => {
    const devServerUrl = 'http://localhost:5173'
    const dev = createSenderGuard({ rendererFile: builtRenderer, devServerUrl })
    const windowUrl = desktopWindowUrl(devServerUrl, DISPLAY_ID)

    expect(windowUrl).toBe(`http://localhost:5173/?displayId=${DISPLAY_ID}`)
    expect(dev(frame(windowUrl))).toBe(true)
    expect(guard(frame(windowUrl))).toBe(false)
  })

  it('rejects look-alikes of the desktop window URL', () => {
    const sibling = pathToFileURL(
      join('C:\\Users\\me\\Taskyard', 'out', 'renderer', 'other.html')
    ).href
    const nested = pathToFileURL(join(builtRenderer, 'index.html')).href

    expect(guard(frame(`${sibling}?displayId=${DISPLAY_ID}`))).toBe(false)
    expect(guard(frame(`${nested}?displayId=${DISPLAY_ID}`))).toBe(false)
    expect(guard(frame(`devtools://devtools/bundled/devtools_app.html?displayId=1`))).toBe(false)
    expect(guard(frame(`http://localhost:5173/?displayId=${DISPLAY_ID}`))).toBe(false)
    expect(guard(frame(`https://evil.example/?displayId=${DISPLAY_ID}`))).toBe(false)
  })
})

describe('handleTrusted', () => {
  const trustedUrl = 'file:///C:/app/out/renderer/index.html?displayId=7'

  function setup(): {
    ipc: FakeIpcMain
    handler: ReturnType<typeof vi.fn>
    warn: ReturnType<typeof vi.fn>
  } {
    const ipc = new FakeIpcMain()
    const handler = vi.fn((_event: unknown, args: unknown[]) => ({ echoed: args }))
    const warn = vi.fn()
    handleTrusted(
      ipc,
      'display:list',
      { isTrustedSender: (event) => event.senderFrame?.url === trustedUrl, log: { warn } },
      handler
    )
    return { ipc, handler, warn }
  }

  it('runs the handler with the arguments for the Taskyard renderer', async () => {
    const { ipc, handler } = setup()

    await expect(
      ipc.invokeFrom({ sender: { id: 3 }, senderFrame: { url: trustedUrl } }, 'display:list', 1, 2)
    ).resolves.toEqual({ echoed: [1, 2] })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('refuses any other sender before the handler runs, and logs where it came from', async () => {
    const { ipc, handler, warn } = setup()

    await expect(
      ipc.invokeFrom(
        { sender: { id: 3 }, senderFrame: { url: 'https://evil.example/' } },
        'display:list'
      )
    ).rejects.toThrow('untrusted sender for display:list')
    await expect(
      ipc.invokeFrom({ sender: { id: 3 }, senderFrame: null }, 'display:list')
    ).rejects.toThrow('untrusted sender for display:list')
    expect(handler).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('ipc: rejected display:list from https://evil.example/')
    expect(warn).toHaveBeenCalledWith('ipc: rejected display:list from a closed frame')
  })
})
