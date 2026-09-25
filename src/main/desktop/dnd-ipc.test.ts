import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { FakeIpcMain, TRUSTED_RENDERER_URL, trustedEvent } from '../ipc/fake-ipc-main'
import type { IpcInvokeEventLike } from '../ipc/sender-guard'
import { cursorOverOtherWindow, registerDragOutIpc, type DragOutDeps } from './dnd-ipc'

const ICON = { isEmpty: () => false }

function setup(overrides: Partial<DragOutDeps> = {}): {
  ipc: FakeIpcMain
  deps: DragOutDeps & { [K in keyof DragOutDeps]: ReturnType<typeof vi.fn> }
  warn: ReturnType<typeof vi.fn>
  unregister: () => void
} {
  const ipc = new FakeIpcMain()
  const warn = vi.fn()
  const deps = {
    paths: vi.fn(async (ids: string[]) =>
      ids.filter((id) => id !== '9:9').map((id) => `C:\\D\\${id.replace(':', '-')}.txt`)
    ),
    icon: vi.fn(async () => ICON),
    startDrag: vi.fn(),
    cursorOverOtherWindow: vi.fn(async () => true),
    primaryButtonDown: vi.fn(async () => true),
    ...overrides
  } as unknown as DragOutDeps & { [K in keyof DragOutDeps]: ReturnType<typeof vi.fn> }
  const unregister = registerDragOutIpc(
    ipc,
    { isTrustedSender: (event) => event.senderFrame?.url === TRUSTED_RENDERER_URL, log: { warn } },
    deps
  )
  return { ipc, deps, warn, unregister }
}

describe('registerDragOutIpc (desktop:startDrag, desktop:cursorOverOtherWindow)', () => {
  it('registers exactly the drag-out channels, and the disposer removes them', () => {
    const { ipc, unregister } = setup()

    expect([...ipc.handlers.keys()].sort()).toEqual(Object.values(IPC.dragOut).sort())
    unregister()
    expect(ipc.handlers.size).toBe(0)
  })

  it('startDrag hands the items’ files and an icon to webContents.startDrag of the sender', async () => {
    const { ipc, deps } = setup()
    const event = trustedEvent(7)

    await expect(ipc.invokeFrom(event, IPC.dragOut.start, ['1:2', '9:9', '1:3'])).resolves.toBe(
      true
    )

    expect(deps.paths).toHaveBeenCalledExactlyOnceWith(['1:2', '9:9', '1:3'])
    expect(deps.icon).toHaveBeenCalledExactlyOnceWith(
      ['1:2', '9:9', '1:3'],
      ['C:\\D\\1-2.txt', 'C:\\D\\1-3.txt']
    )
    expect(deps.startDrag).toHaveBeenCalledExactlyOnceWith(event, {
      file: 'C:\\D\\1-2.txt',
      files: ['C:\\D\\1-2.txt', 'C:\\D\\1-3.txt'],
      icon: ICON
    })
  })

  it('starts nothing when no id is on the desktop or there is no icon', async () => {
    const { ipc, deps, warn } = setup()
    await expect(ipc.invoke(IPC.dragOut.start, ['9:9'])).resolves.toBe(false)

    deps.icon.mockResolvedValueOnce(null)
    await expect(ipc.invoke(IPC.dragOut.start, ['1:2'])).resolves.toBe(false)

    expect(deps.startDrag).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('dnd: no icon for the drag of 1 item(s); not started')
  })

  it('never drags when the physical mouse button is not down (touch, pen or synthetic input)', async () => {
    const { ipc, deps } = setup()
    deps.primaryButtonDown.mockResolvedValue(false)

    await expect(ipc.invoke(IPC.dragOut.start, ['1:2'])).resolves.toBe(false)
    await expect(ipc.invoke(IPC.dragOut.probe)).resolves.toBe(false)

    expect(deps.startDrag).not.toHaveBeenCalled()
    expect(deps.cursorOverOtherWindow).not.toHaveBeenCalled()
  })

  it('answers cursorOverOtherWindow for the sender', async () => {
    const { ipc, deps } = setup()
    const event = trustedEvent(3)

    await expect(ipc.invokeFrom(event, IPC.dragOut.probe)).resolves.toBe(true)
    expect(deps.cursorOverOtherWindow).toHaveBeenCalledExactlyOnceWith(event)
  })

  it('rejects malformed arguments and untrusted senders before anything runs', async () => {
    const { ipc, deps, warn } = setup()
    const bad: unknown[][] = [[], [[]], [['not-an-id']], ['1:2'], [['1:2'], 'extra']]
    for (const args of bad) {
      await expect(ipc.invoke(IPC.dragOut.start, ...args)).rejects.toThrow(
        `invalid arguments for ${IPC.dragOut.start}`
      )
    }
    await expect(ipc.invoke(IPC.dragOut.probe, 1)).rejects.toThrow('invalid arguments')
    expect(warn).toHaveBeenCalledTimes(bad.length + 1)

    const evil: IpcInvokeEventLike = {
      sender: { id: 9 },
      senderFrame: { url: 'https://evil.example/' }
    }
    await expect(ipc.invokeFrom(evil, IPC.dragOut.start, ['1:2'])).rejects.toThrow(
      'untrusted sender'
    )
    await expect(ipc.invokeFrom(evil, IPC.dragOut.probe)).rejects.toThrow('untrusted sender')
    for (const fn of Object.values(deps)) expect(fn).not.toHaveBeenCalled()
  })
})

describe('cursorOverOtherWindow', () => {
  it('is true only when a window other than our own is under the cursor', () => {
    expect(cursorOverOtherWindow({ rootWindowAtCursor: () => 0x20n }, 0x10n)).toBe(true)
    expect(cursorOverOtherWindow({ rootWindowAtCursor: () => 0x10n }, 0x10n)).toBe(false)
    expect(cursorOverOtherWindow({ rootWindowAtCursor: () => null }, 0x10n)).toBe(false)
    // Our window is unknown (closing): never hand over.
    expect(cursorOverOtherWindow({ rootWindowAtCursor: () => 0x20n }, null)).toBe(false)
  })
})
