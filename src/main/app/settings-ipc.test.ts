import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_IPC } from '@shared/ipc'
import { FakeIpcMain } from '../ipc/fake-ipc-main'
import { registerSettingsIpc, type SettingsIpcDeps } from './settings-ipc'

const log = { warn: vi.fn() }

let ipc: FakeIpcMain
let target: { peek: ReturnType<typeof vi.fn>; releaseHold: ReturnType<typeof vi.fn> }
let deps: SettingsIpcDeps

beforeEach(() => {
  ipc = new FakeIpcMain()
  target = { peek: vi.fn(), releaseHold: vi.fn() }
  deps = {
    peek: () => target,
    openPath: vi.fn(async () => ''),
    dataDir: 'C:\\Users\\me\\AppData\\Roaming\\Taskyard',
    info: { name: 'Taskyard', version: '0.1.0' },
    log: { warn: vi.fn() }
  }
  registerSettingsIpc(ipc, { isTrustedSender: () => true, log }, deps)
})

describe('settings inspector requests (main)', () => {
  it('opening the inspector holds a Peek; closing releases the hold', async () => {
    await ipc.invoke(SETTINGS_IPC.peekHold, true)
    expect(target.peek).toHaveBeenCalledExactlyOnceWith(true, { hold: 'inspector' })

    await ipc.invoke(SETTINGS_IPC.peekHold, false)
    expect(target.releaseHold).toHaveBeenCalledExactlyOnceWith('inspector')
    expect(target.peek).toHaveBeenCalledOnce()
  })

  it('does nothing before the desktop windows exist', async () => {
    deps.peek = () => null
    await expect(ipc.invoke(SETTINGS_IPC.peekHold, true)).resolves.toBeUndefined()
  })

  it('opens the data folder in Explorer', async () => {
    await expect(ipc.invoke(SETTINGS_IPC.openDataFolder)).resolves.toBe(true)
    expect(deps.openPath).toHaveBeenCalledExactlyOnceWith(deps.dataDir)
  })

  it('reports a data folder Windows could not open', async () => {
    deps.openPath = vi.fn(async () => 'The system cannot find the path specified.')
    await expect(ipc.invoke(SETTINGS_IPC.openDataFolder)).resolves.toBe(false)
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not open the data folder'),
      'The system cannot find the path specified.'
    )
  })

  it('describes the app for About', async () => {
    await expect(ipc.invoke(SETTINGS_IPC.info)).resolves.toEqual({
      name: 'Taskyard',
      version: '0.1.0',
      dataDir: 'C:\\Users\\me\\AppData\\Roaming\\Taskyard'
    })
  })

  it('refuses bad arguments', async () => {
    await expect(ipc.invoke(SETTINGS_IPC.peekHold, 'yes')).rejects.toThrow(/invalid arguments/)
    await expect(ipc.invoke(SETTINGS_IPC.openDataFolder, 'C:\\')).rejects.toThrow(
      /invalid arguments/
    )
    expect(target.peek).not.toHaveBeenCalled()
  })
})
