import { createFakeShellMenuApi } from '../win32/shell-menu-fake'
import {
  splitMenuText,
  type ShellMenuApi,
  type ShellMenuItem,
  type ShellMenuTarget
} from '../win32/shell-menu-api'
import { FakeHelperChild } from './fake-helper-child'
import { createShellMenuHost, type ShellMenuHost, type ShellMenuHostDeps } from './host'

/**
 * TASKYARD_FAKE_SHELL_MENU=1 (e2e only): the real host and helper core over the fake shell-menu
 * api, in-process, with a script of what the "user" does in each native menu. Nothing touches
 * Windows' shell, so no real menu ever appears during an automated run. The spec drives it from
 * the main process: `app.evaluate(() => globalThis.__taskyardShellMenu.script(...))`.
 */

export const SHELL_MENU_SCRIPT_GLOBAL = '__taskyardShellMenu'

/** What happens in the next menu. `choose` is a label path (access keys ignored). */
export type ShellMenuScriptStep =
  | { dismiss: true }
  | { choose: string[]; failInvoke?: string }
  /** The helper fails before the menu shows (e.g. no foreground): main falls back. */
  | { fail: string }
  /** The helper process dies with the menu request: main falls back, the next request respawns. */
  | { crash: true }

export interface ShellMenuScriptControl {
  /** Appends steps, one per menu; with none left, menus are dismissed. */
  script(...steps: ShellMenuScriptStep[]): void
  /** What each menu was asked for (target, physical point, Shift). */
  readonly shown: {
    target: ShellMenuTarget
    point: { x: number; y: number }
    extendedVerbs: boolean
  }[]
  /** The verbs of the shell items the script ran (never on the real shell). */
  readonly invoked: (string | null)[]
  setClipboardPasteable(pasteable: boolean): void
}

/** The id of the item at `path` (labels without access keys), or null. */
function findPath(menu: ShellMenuItem[], path: string[]): number | null {
  const [head, ...rest] = path
  const found = menu.find((item) => !item.separator && splitMenuText(item.label).label === head)
  if (!found) return null
  if (rest.length === 0) return found.submenu === null ? found.id : null
  return found.submenu ? findPath(found.submenu, rest) : null
}

export function createScriptedShellMenu(deps: { log: ShellMenuHostDeps['log'] }): {
  host: ShellMenuHost
  control: ShellMenuScriptControl
} {
  const steps: ShellMenuScriptStep[] = []
  const shown: ShellMenuScriptControl['shown'] = []
  let chosen = 0
  const fake = createFakeShellMenuApi({ choose: () => chosen })
  let child: FakeHelperChild | null = null

  const api: ShellMenuApi = {
    enumerate: (target, options) => fake.enumerate(target, options),
    preview: (request) => fake.preview(request),
    invokeVerb: (target, verb) => fake.invokeVerb(target, verb),
    pumpMessages: () => fake.pumpMessages(),
    dispose: () => fake.dispose(),
    show(request, hooks) {
      const step = steps.shift() ?? { dismiss: true }
      if ('fail' in step) throw new Error(step.fail)
      if ('crash' in step) {
        child?.crash()
        throw new Error('the scripted helper crashed')
      }
      shown.push({
        target: request.target,
        point: { ...request.point },
        extendedVerbs: request.extendedVerbs
      })
      chosen = 0
      if ('choose' in step) {
        // Found before the menu "shows": a script naming nothing is a test error, not a click.
        const id = findPath(fake.preview(request), step.choose)
        if (id === null) throw new Error(`the scripted menu has no item ${step.choose.join(' › ')}`)
        chosen = id
        if (step.failInvoke !== undefined) fake.failNextInvoke(new Error(step.failInvoke))
      }
      return fake.show(request, hooks)
    }
  }

  const host = createShellMenuHost({
    fork: () => {
      child = new FakeHelperChild({ api })
      return child
    },
    // Nothing real to grant or dismiss: the fake owner window is not a real HWND.
    allowForeground: () => {},
    cancelMenu: () => {},
    log: deps.log
  })

  return {
    host,
    control: {
      script: (...more) => {
        steps.push(...more)
      },
      shown,
      get invoked() {
        return fake.invoked.map((entry) => entry.verb)
      },
      setClipboardPasteable: (pasteable) => fake.setClipboardPasteable(pasteable)
    }
  }
}
