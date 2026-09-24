import { describe, expect, it, vi } from 'vitest'
import type { Win32Api } from './api'
import type { Koffi } from './bindings'
import { createWin32Api, fakeReason, type CreateWin32ApiDeps } from './index'

function fakeLog(): CreateWin32ApiDeps['log'] {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

const stubKoffi = { load: vi.fn(() => ({})) } as unknown as Koffi

describe('fakeReason', () => {
  it('names TASKYARD_NO_WIN32=1', () => {
    expect(fakeReason({ TASKYARD_NO_WIN32: '1' }, 'win32')).toBe('TASKYARD_NO_WIN32=1')
  })

  it('names a platform other than Windows', () => {
    expect(fakeReason({}, 'linux')).toBe('platform linux')
  })

  it.each([undefined, '', '0', 'true'])('is null on Windows when TASKYARD_NO_WIN32 is %j', (v) => {
    expect(fakeReason({ TASKYARD_NO_WIN32: v }, 'win32')).toBeNull()
  })
})

describe('createWin32Api', () => {
  it('uses the fake without touching koffi when TASKYARD_NO_WIN32=1', async () => {
    const importKoffi = vi.fn(async () => stubKoffi)
    const log = fakeLog()

    const result = await createWin32Api({
      env: { TASKYARD_NO_WIN32: '1' },
      platform: 'win32',
      isPackaged: false,
      log,
      importKoffi
    })

    expect(result.kind).toBe('fake')
    expect(result.kind === 'fake' && result.api.getShellWindow()).not.toBeNull()
    expect(importKoffi).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith('win32: using the fake api (TASKYARD_NO_WIN32=1)')
  })

  it('uses the fake off Windows', async () => {
    const result = await createWin32Api({
      env: {},
      platform: 'darwin',
      isPackaged: false,
      log: fakeLog(),
      importKoffi: async () => stubKoffi
    })

    expect(result.kind).toBe('fake')
  })

  it('probes user32 and builds the koffi api on Windows', async () => {
    const api = {} as Win32Api
    const createKoffiApi = vi.fn(() => api)
    const log = fakeLog()

    const result = await createWin32Api({
      env: {},
      platform: 'win32',
      isPackaged: true,
      log,
      importKoffi: async () => stubKoffi,
      createKoffiApi
    })

    expect(result).toEqual({ kind: 'koffi', api })
    expect(createKoffiApi).toHaveBeenCalledExactlyOnceWith(stubKoffi, { log })
    expect(log.info).toHaveBeenCalledWith('koffi: user32 loaded (packaged)')
  })

  it('reports Win32 as unavailable (never the fake) when koffi cannot load on Windows', async () => {
    const failure = new Error('Cannot find the native Koffi module')
    const log = fakeLog()

    const result = await createWin32Api({
      env: {},
      platform: 'win32',
      isPackaged: false,
      log,
      importKoffi: () => Promise.reject(failure)
    })

    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'koffi could not load user32.dll (see the log)'
    })
    expect(log.error).toHaveBeenCalledWith('koffi: user32 load failed (dev)', failure)
  })

  it('reports Win32 as unavailable when the bindings cannot be declared', async () => {
    const failure = new Error('comctl32 missing')
    const log = fakeLog()

    const result = await createWin32Api({
      env: {},
      platform: 'win32',
      isPackaged: false,
      log,
      importKoffi: async () => stubKoffi,
      createKoffiApi: () => {
        throw failure
      }
    })

    expect(result).toEqual({
      kind: 'unavailable',
      reason: 'the Win32 bindings failed: comctl32 missing'
    })
    expect(log.error).toHaveBeenCalledWith('win32: koffi bindings failed', failure)
  })
})
