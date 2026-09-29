import { describe, expect, it, vi, type Mock } from 'vitest'
import { createFakeWin32Api, type FakeWin32Api } from '../win32/fake-api'
import {
  createAppShellMenu,
  SHELL_MENU_HELPER_FILE,
  SHELL_MENU_SERVICE_NAME
} from './app-shell-menu'
import type { ShellMenuHost } from './host'
import { FakeHelperChild } from './fake-helper-child'

function setup(allow = true): {
  host: ShellMenuHost
  fork: Mock
  win32: FakeWin32Api
  log: { info: Mock; warn: Mock; error: Mock }
  children: FakeHelperChild[]
} {
  const children: FakeHelperChild[] = []
  const fork = vi.fn(() => {
    const child = new FakeHelperChild({ pid: 5150 })
    children.push(child)
    return child
  })
  const win32 = createFakeWin32Api()
  vi.spyOn(win32, 'allowSetForegroundWindow').mockReturnValue(allow)
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const host = createAppShellMenu({
    utilityProcess: { fork },
    helperFile: 'C:\\app\\out\\main\\shell-menu-helper.js',
    win32,
    log
  })
  return { host, fork, win32, log, children }
}

const REQUEST = {
  target: { kind: 'desktop-background' as const },
  point: { x: 5, y: 6 },
  extendedVerbs: false,
  taskyardItems: [],
  interceptVerbs: [],
  interceptSubmenus: [],
  hideVerbs: [],
  hideSubmenus: [],
  replaceSubmenus: []
}

describe('createAppShellMenu', () => {
  it('names the bundled helper entry', () => {
    expect(SHELL_MENU_HELPER_FILE).toBe('shell-menu-helper.js')
  })

  it('forks the helper as a named utility process and reports it ready', async () => {
    const { host, fork, log } = setup()
    await expect(host.start()).resolves.toEqual({ pid: 5150 })
    expect(fork).toHaveBeenCalledWith('C:\\app\\out\\main\\shell-menu-helper.js', [], {
      serviceName: SHELL_MENU_SERVICE_NAME
    })
    expect(SHELL_MENU_SERVICE_NAME).toBe('Taskyard Shell Menu')
    expect(log.info).toHaveBeenCalledWith('shell-menu: helper ready (pid 5150)')
    host.dispose()
  })

  it('grants the helper the foreground (AllowSetForegroundWindow) before each menu', async () => {
    const { host, win32 } = setup()
    await expect(host.show(REQUEST)).resolves.toEqual({ kind: 'dismissed' })
    expect(win32.allowSetForegroundWindow).toHaveBeenCalledWith(5150)
    host.dispose()
  })

  it('warns when Windows refuses the grant (the menu may not close on an outside click)', async () => {
    const { host, log } = setup(false)
    await host.show(REQUEST)
    expect(log.warn).toHaveBeenCalledWith(
      'shell-menu: AllowSetForegroundWindow(5150) was refused; the menu may not take the foreground'
    )
    host.dispose()
  })
})
