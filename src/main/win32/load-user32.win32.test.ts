import { describe, expect, it, vi, type Mock } from 'vitest'
import { realWin32TestsEnabled } from '../test/win32-opt-in'
import { loadUser32 } from './load-user32'

function fakeLog(): {
  info: Mock<(message: string) => void>
  error: Mock<(message: string, error: unknown) => void>
} {
  return { info: vi.fn(), error: vi.fn() }
}

// Opt-in: npm run test:win32 (never part of npm test, never under TASKYARD_NO_WIN32=1).
describe.runIf(realWin32TestsEnabled())('loadUser32 (real Win32)', () => {
  it('loads the real user32.dll through koffi on Windows', async () => {
    const log = fakeLog()

    const lib = await loadUser32({
      importKoffi: async () => (await import('koffi')).default,
      isPackaged: false,
      log
    })

    expect(lib).not.toBeNull()
    expect(log.error).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledExactlyOnceWith('koffi: user32 loaded (dev)')
  })
})
