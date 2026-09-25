import { describe, expect, it, vi, type Mock } from 'vitest'
import { defaultSettings } from '@shared/defaults'
import { TIMER_IPC } from '@shared/ipc'
import type { SettingsFile } from '@shared/schema'
import { FakeIpcMain, TRUSTED_RENDERER_URL } from '../ipc/fake-ipc-main'
import {
  createTimerNotifier,
  registerTimerIpc,
  timerNotificationContent,
  type NotificationOptionsLike
} from './notifications'

interface Setup {
  ipc: FakeIpcMain
  shown: NotificationOptionsLike[]
  show: Mock<() => void>
  create: Mock<(options: NotificationOptionsLike) => { show(): void }>
  warn: Mock<(message: string, ...details: unknown[]) => void>
  current: SettingsFile
}

function setup(settings: Partial<SettingsFile> = {}, supported = true): Setup {
  const ipc = new FakeIpcMain()
  const shown: NotificationOptionsLike[] = []
  const show = vi.fn<() => void>()
  const warn = vi.fn<(message: string, ...details: unknown[]) => void>()
  const create = vi.fn((options: NotificationOptionsLike) => {
    shown.push(options)
    return { show }
  })
  const current = { ...defaultSettings(), ...settings }
  const notifier = createTimerNotifier({
    settings: () => current,
    createNotification: create,
    isSupported: () => supported,
    log: { warn, info: vi.fn() }
  })
  registerTimerIpc(ipc, notifier, {
    isTrustedSender: (event) => event.senderFrame?.url === TRUSTED_RENDERER_URL,
    log: { warn }
  })
  return { ipc, shown, show, create, warn, current }
}

describe('timer notifications', () => {
  it('timer:notify shows a Windows notification naming the linked task', async () => {
    const { ipc, shown, show } = setup()

    const result = await ipc.invoke(TIMER_IPC.notify, { endsAt: 1000, taskText: 'Write report' })

    expect(result).toBe(true)
    expect(shown).toEqual([
      { title: 'Timer finished', body: 'Time’s up for “Write report”.', silent: true }
    ])
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('without a linked task the body is generic', () => {
    expect(timerNotificationContent()).toEqual({
      title: 'Timer finished',
      body: 'Your countdown has ended.'
    })
  })

  it('is skipped when timerNotify is off', async () => {
    const { ipc, create } = setup({ timerNotify: false })

    expect(await ipc.invoke(TIMER_IPC.notify, { endsAt: 1000 })).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })

  it('reads the setting when the timer finishes, not when registered', async () => {
    const { ipc, create, current } = setup()
    current.timerNotify = false

    await ipc.invoke(TIMER_IPC.notify, { endsAt: 1000 })

    expect(create).not.toHaveBeenCalled()
  })

  it('shows one notification per countdown (two windows reporting the same endsAt)', async () => {
    const { ipc, create } = setup()

    expect(await ipc.invoke(TIMER_IPC.notify, { endsAt: 5000 })).toBe(true)
    expect(await ipc.invoke(TIMER_IPC.notify, { endsAt: 5000 })).toBe(false)
    expect(await ipc.invoke(TIMER_IPC.notify, { endsAt: 9000 })).toBe(true)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('is skipped (with a warning) when Windows notifications are unsupported', async () => {
    const { ipc, create, warn } = setup({}, false)

    expect(await ipc.invoke(TIMER_IPC.notify, { endsAt: 1 })).toBe(false)
    expect(create).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('validates its argument with zod before anything is shown', async () => {
    const { ipc, create } = setup()
    const bad = [
      undefined,
      'Write report',
      { endsAt: -1 },
      { endsAt: 1.5 },
      { endsAt: 1, taskText: '' },
      { endsAt: 1, taskText: 'x'.repeat(501) },
      { endsAt: 1, extra: true }
    ]
    for (const request of bad) {
      await expect(ipc.invoke(TIMER_IPC.notify, request)).rejects.toThrow(/invalid arguments/)
    }
    await expect(ipc.invoke(TIMER_IPC.notify, { endsAt: 1 }, 'extra')).rejects.toThrow(
      /invalid arguments/
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses senders other than the Taskyard renderer', async () => {
    const { ipc, create, warn } = setup()

    await expect(
      ipc.invokeFrom(
        { sender: { id: 3 }, senderFrame: { url: 'https://evil.example/' } },
        TIMER_IPC.notify,
        { endsAt: 1 }
      )
    ).rejects.toThrow(/untrusted/)
    expect(create).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
