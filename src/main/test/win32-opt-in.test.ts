import { describe, expect, it } from 'vitest'
import { realWin32TestsEnabled, WIN32_TESTS_ENV } from './win32-opt-in'

describe('realWin32TestsEnabled', () => {
  it('is on only on Windows with TASKYARD_WIN32_TESTS=1', () => {
    expect(WIN32_TESTS_ENV).toBe('TASKYARD_WIN32_TESTS')
    expect(realWin32TestsEnabled({ TASKYARD_WIN32_TESTS: '1' }, 'win32')).toBe(true)
    expect(realWin32TestsEnabled({}, 'win32')).toBe(false)
    expect(realWin32TestsEnabled({ TASKYARD_WIN32_TESTS: '1' }, 'linux')).toBe(false)
  })

  it('is always off under TASKYARD_NO_WIN32=1', () => {
    expect(
      realWin32TestsEnabled({ TASKYARD_WIN32_TESTS: '1', TASKYARD_NO_WIN32: '1' }, 'win32')
    ).toBe(false)
  })
})
