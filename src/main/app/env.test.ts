import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { applyUserDataOverride, ENV, resolveLogLevel, shellMenuMode } from './env'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'taskyard-env-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function fakeApp(): { setPath: Mock<(name: 'userData', path: string) => void> } {
  return { setPath: vi.fn() }
}

describe('ENV', () => {
  it('names the override variables', () => {
    expect(ENV).toEqual({
      userData: 'TASKYARD_USER_DATA',
      logLevel: 'TASKYARD_LOG_LEVEL',
      noWin32: 'TASKYARD_NO_WIN32',
      desktopDirs: 'TASKYARD_DESKTOP_DIRS',
      fakeShellMenu: 'TASKYARD_FAKE_SHELL_MENU'
    })
  })
})

describe('shellMenuMode (native menus, Phase 3)', () => {
  it('uses the real helper with real Win32 only, unless told otherwise', () => {
    expect(shellMenuMode({}, 'koffi')).toBe('real')
    expect(shellMenuMode({}, 'fake')).toBe('off')
    expect(shellMenuMode({}, 'unavailable')).toBe('off')
  })

  it('TASKYARD_FAKE_SHELL_MENU=1 scripts the menus (e2e); 0 turns native menus off', () => {
    expect(shellMenuMode({ TASKYARD_FAKE_SHELL_MENU: '1' }, 'koffi')).toBe('fake')
    expect(shellMenuMode({ TASKYARD_FAKE_SHELL_MENU: '1' }, 'fake')).toBe('fake')
    expect(shellMenuMode({ TASKYARD_FAKE_SHELL_MENU: '0' }, 'koffi')).toBe('off')
    expect(shellMenuMode({ TASKYARD_FAKE_SHELL_MENU: ' 1 ' }, 'koffi')).toBe('fake')
    // Anything else is ignored.
    expect(shellMenuMode({ TASKYARD_FAKE_SHELL_MENU: 'yes' }, 'koffi')).toBe('real')
  })
})

describe('applyUserDataOverride', () => {
  it('points userData at TASKYARD_USER_DATA, creating the directory first', () => {
    const app = fakeApp()
    const dir = join(tmp, 'profile', 'nested')

    const applied = applyUserDataOverride(app, { TASKYARD_USER_DATA: dir })

    expect(applied).toBe(dir)
    expect(existsSync(dir)).toBe(true)
    expect(app.setPath).toHaveBeenCalledExactlyOnceWith('userData', dir)
  })

  it('resolves a relative override against the working directory', () => {
    const app = fakeApp()
    const relative = join('.', 'relative-profile')
    const cwd = process.cwd()
    process.chdir(tmp)
    try {
      applyUserDataOverride(app, { TASKYARD_USER_DATA: relative })
    } finally {
      process.chdir(cwd)
    }

    expect(app.setPath).toHaveBeenCalledWith('userData', resolve(tmp, relative))
  })

  it.each([undefined, '', '   '])('leaves userData alone when the override is %j', (value) => {
    const app = fakeApp()

    expect(applyUserDataOverride(app, { TASKYARD_USER_DATA: value })).toBeNull()
    expect(app.setPath).not.toHaveBeenCalled()
  })
})

describe('resolveLogLevel', () => {
  it.each(['error', 'warn', 'info', 'verbose', 'debug', 'silly'] as const)(
    'accepts %s',
    (level) => {
      expect(resolveLogLevel(level)).toBe(level)
    }
  )

  it('is case- and whitespace-insensitive', () => {
    expect(resolveLogLevel('  DEBUG ')).toBe('debug')
  })

  it.each([undefined, '', 'loud', 'trace'])('falls back to info for %j', (value) => {
    expect(resolveLogLevel(value)).toBe('info')
  })
})
