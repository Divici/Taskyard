import { describe, expect, it, vi, type Mock } from 'vitest'
import { loadUser32, user32LoadedMessage, USER32_DLL, type KoffiLoader } from './load-user32'

function fakeLog(): {
  info: Mock<(message: string) => void>
  error: Mock<(message: string, error: unknown) => void>
} {
  return { info: vi.fn(), error: vi.fn() }
}

describe('user32LoadedMessage', () => {
  it('names the build flavour exactly as verify:koffi expects', () => {
    expect(user32LoadedMessage(true)).toBe('koffi: user32 loaded (packaged)')
    expect(user32LoadedMessage(false)).toBe('koffi: user32 loaded (dev)')
  })
})

describe('loadUser32', () => {
  it('loads user32.dll and logs the packaged success line', async () => {
    const handle = { name: 'user32' }
    const koffi = { load: vi.fn(() => handle) }
    const log = fakeLog()

    const result = await loadUser32({ importKoffi: () => koffi, isPackaged: true, log })

    expect(result).toBe(handle)
    expect(koffi.load).toHaveBeenCalledExactlyOnceWith(USER32_DLL)
    expect(USER32_DLL).toBe('user32.dll')
    expect(log.info).toHaveBeenCalledExactlyOnceWith('koffi: user32 loaded (packaged)')
    expect(log.error).not.toHaveBeenCalled()
  })

  it('logs the dev success line when not packaged', async () => {
    const log = fakeLog()

    await loadUser32({ importKoffi: async () => ({ load: () => ({}) }), isPackaged: false, log })

    expect(log.info).toHaveBeenCalledExactlyOnceWith('koffi: user32 loaded (dev)')
  })

  it('logs and swallows a failure to import the native koffi module', async () => {
    const failure = new Error('Cannot find the native Koffi module; did you bundle it correctly?')
    const log = fakeLog()

    const result = await loadUser32({
      importKoffi: () => Promise.reject(failure),
      isPackaged: true,
      log
    })

    expect(result).toBeNull()
    expect(log.info).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledExactlyOnceWith(
      'koffi: user32 load failed (packaged)',
      failure
    )
  })

  it('logs and swallows a failure inside koffi.load', async () => {
    const failure = new Error('LoadLibrary failed')
    const log = fakeLog()
    const koffi: KoffiLoader = {
      load: () => {
        throw failure
      }
    }

    const result = await loadUser32({ importKoffi: () => koffi, isPackaged: false, log })

    expect(result).toBeNull()
    expect(log.error).toHaveBeenCalledExactlyOnceWith('koffi: user32 load failed (dev)', failure)
  })
})
