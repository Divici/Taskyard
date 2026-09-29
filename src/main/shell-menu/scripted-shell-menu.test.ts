import { afterEach, describe, expect, it, vi } from 'vitest'
import { backgroundMenuPolicy } from '@shared/shell-menu'
import type { ShowMenuRequest } from '../win32/shell-menu-api'
import { createScriptedShellMenu, SHELL_MENU_SCRIPT_GLOBAL } from './scripted-shell-menu'

const REQUEST: ShowMenuRequest = {
  target: { kind: 'desktop-background' },
  point: { x: 10, y: 20 },
  extendedVerbs: false,
  ...backgroundMenuPolicy({
    iconSize: 'medium',
    gridSnap: false,
    quickHidden: false,
    toolsShown: false
  }),
  returnFocusTo: '1'
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

describe('createScriptedShellMenu (TASKYARD_FAKE_SHELL_MENU=1, e2e)', () => {
  let made: ReturnType<typeof createScriptedShellMenu> | null = null
  afterEach(() => {
    made?.host.dispose()
    made = null
  })

  it('names the main-process global the e2e specs script it through', () => {
    expect(SHELL_MENU_SCRIPT_GLOBAL).toBe('__taskyardShellMenu')
  })

  it('dismisses when nothing is scripted, and records what was shown', async () => {
    made = createScriptedShellMenu({ log })
    await expect(made.host.show(REQUEST)).resolves.toEqual({ kind: 'dismissed' })
    expect(made.control.shown).toEqual([
      { target: { kind: 'desktop-background' }, point: { x: 10, y: 20 }, extendedVerbs: false }
    ])
  })

  it('chooses by label path (access keys ignored), one step per menu', async () => {
    made = createScriptedShellMenu({ log })
    made.control.script(
      { choose: ['Taskyard', 'New group here'] },
      { choose: ['View', 'Small icons'] },
      { choose: ['Refresh'] },
      { choose: ['New', 'Folder'] }
    )
    await expect(made.host.show(REQUEST)).resolves.toEqual({
      kind: 'taskyard',
      id: 'taskyard.new-group'
    })
    await expect(made.host.show(REQUEST)).resolves.toEqual({
      kind: 'taskyard',
      id: 'view.icon-small'
    })
    await expect(made.host.show(REQUEST)).resolves.toMatchObject({
      kind: 'intercepted',
      verb: 'refresh'
    })
    await expect(made.host.show(REQUEST)).resolves.toMatchObject({
      kind: 'invoked',
      verb: 'NewFolder'
    })
    expect(made.control.invoked).toEqual(['NewFolder'])
  })

  it('fails before showing (a helper error), or crashes the helper: both are rejections', async () => {
    made = createScriptedShellMenu({ log })
    made.control.script({ fail: 'no foreground' }, { crash: true })
    await expect(made.host.show(REQUEST)).rejects.toMatchObject({
      code: 'request-failed',
      message: 'no foreground'
    })
    await expect(made.host.show(REQUEST)).rejects.toMatchObject({ code: 'helper-exited' })
    // The next request gets a new helper.
    await expect(made.host.show(REQUEST)).resolves.toEqual({ kind: 'dismissed' })
  })

  it('makes a chosen item fail to run (invoke-failed)', async () => {
    made = createScriptedShellMenu({ log })
    made.control.script({ choose: ['Open in Terminal'], failInvoke: 'Access is denied.' })
    await expect(made.host.show(REQUEST)).resolves.toMatchObject({
      kind: 'invoke-failed',
      label: 'Open in Terminal',
      message: 'Access is denied.'
    })
  })

  it('reports a choice it cannot find instead of guessing', async () => {
    made = createScriptedShellMenu({ log })
    made.control.script({ choose: ['Nope'] })
    await expect(made.host.show(REQUEST)).rejects.toMatchObject({ code: 'request-failed' })
  })
})
