import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { FakeIpcMain } from '../ipc/fake-ipc-main'
import { createQuickHide, registerQuickHideIpc, type QuickHide } from './quick-hide'

const log = { warn: vi.fn() }

let ipc: FakeIpcMain
let emit: ReturnType<typeof vi.fn>
let quickHide: QuickHide

beforeEach(() => {
  ipc = new FakeIpcMain()
  emit = vi.fn()
  quickHide = createQuickHide({ emit })
  registerQuickHideIpc(ipc, { isTrustedSender: () => true, log }, quickHide)
})

describe('quick-hide across displays (main)', () => {
  it('starts shown every launch: the state lives in memory only, never in a file', async () => {
    expect(await ipc.invoke(IPC.quickHide.get)).toBe(false)
  })

  it('one window hiding tells every window (the saver too), once per change', async () => {
    await ipc.invoke(IPC.quickHide.set, true)
    expect(emit).toHaveBeenCalledExactlyOnceWith('quickHide:changed', { hidden: true })
    expect(await ipc.invoke(IPC.quickHide.get)).toBe(true)

    await ipc.invoke(IPC.quickHide.set, true)
    expect(emit).toHaveBeenCalledOnce()

    await ipc.invoke(IPC.quickHide.set, false)
    expect(emit).toHaveBeenLastCalledWith('quickHide:changed', { hidden: false })
  })

  it('refuses anything but a boolean', async () => {
    await expect(ipc.invoke(IPC.quickHide.set, 'yes')).rejects.toThrow(/invalid arguments/)
    expect(quickHide.hidden).toBe(false)
  })
})
