import {
  DEFAULT_BACKGROUND_SOURCE,
  type BackgroundSource,
  type ShellMenuApi,
  type ShellMenuItem,
  type ShellMenuTarget,
  type ShowMenuOutcome,
  type ShowMenuRequest
} from './shell-menu-api'
import {
  FOREGROUND_REFUSED,
  invokeOutcome,
  invokesByVerb,
  resolveShown,
  returnsFocus,
  runInvoke,
  shapeMenu
} from './shell-menu-shape'

/**
 * A `ShellMenuApi` over scripted menus, for headless tests (and a scripted-choice fake mode):
 * `show` shapes the menu with the same pure rules the real one follows (`shapeMenu`: Windows'
 * labels, replaced submenus, hidden items, Taskyard's items on top), lets `choose` pick an id
 * from it, and resolves and invokes it with the shared `resolveShown` / `invokeOutcome` — so id
 * mapping, interception, the view-state guard and invoke failures behave as in the helper.
 */
export interface FakeShellMenuApi extends ShellMenuApi {
  /** Every invoked verb (from `invokeVerb` or a chosen, non-intercepted shell item). */
  readonly invoked: { target: ShellMenuTarget; verb: string | null }[]
  /** How each entry of `invoked` ran: by command id (a chosen item) or by verb string. */
  readonly invokedBy: ('id' | 'verb')[]
  readonly shown: ShowMenuRequest[]
  readonly disposed: boolean
  /** How many times `pumpMessages` ran. */
  readonly pumps: number
  /** The next `pumpMessages` throws `error`. */
  failNextPump(error: Error): void
  /** The scripted shell items for a target (what `enumerate` answers). */
  menuFor(target: ShellMenuTarget, source: BackgroundSource): ShellMenuItem[]
  /** The next call (any method) throws `error`. */
  failNext(error: Error): void
  /** The next invoke (a chosen shell item, or `invokeVerb`) throws `error`. */
  failNextInvoke(error: Error): void
  /** How many times the clipboard / drop target was asked about Paste (show, or pasteState). */
  readonly pasteProbes: number
  setClipboardPasteable(pasteable: boolean): void
  setChoice(choose: FakeChoice): void
  /** Windows lets (true) or refuses (false) the helper's owner window the foreground. */
  setForeground(granted: boolean): void
  /** The windows `show` gave the foreground back to (`returnFocusTo`, when `returnsFocus`). */
  readonly focusReturns: bigint[]
}

/** Picks the id the user "clicks" in the menu as shown; 0 dismisses. */
export type FakeChoice = (menu: ShellMenuItem[], request: ShowMenuRequest) => number

export interface FakeShellMenuOptions {
  menus?: (target: ShellMenuTarget, source: BackgroundSource) => ShellMenuItem[]
  choose?: FakeChoice
  ownerHwnd?: bigint
  /** What the clipboard probe answers (a pasteable clipboard or not); false by default. */
  clipboardPasteable?: boolean
  /** False: the owner window cannot take the foreground, so `show` fails before showing. */
  foreground?: boolean
}

export const FAKE_OWNER_HWND = 0x5e11n

function entry(id: number, label: string, verb: string | null = null): ShellMenuItem {
  return {
    id,
    label,
    accelerator: null,
    verb,
    separator: false,
    disabled: false,
    checked: false,
    submenu: null
  }
}

function separator(): ShellMenuItem {
  return { ...entry(0, ''), separator: true }
}

function submenu(label: string, items: ShellMenuItem[]): ShellMenuItem {
  return { ...entry(0, label), submenu: items }
}

/** A background menu shaped like the one the spike read from this machine's DefView. */
export function sampleBackgroundMenu(desktop: boolean): ShellMenuItem[] {
  return [
    submenu('View', [
      entry(1, 'Large icons', 'viewlogicaliconslarge'),
      entry(2, 'Medium icons', 'viewlogicaliconsmedium'),
      entry(3, 'Small icons', 'viewlogicaliconssmall'),
      separator(),
      entry(4, 'Auto arrange', 'arrangeauto')
    ]),
    submenu('Sort by', [
      entry(5, 'Name'),
      entry(6, 'Size'),
      entry(7, 'Item type'),
      entry(8, 'Date modified'),
      separator(),
      entry(9, 'Ascending', 'sortascending'),
      entry(10, 'Descending', 'sortdescending')
    ]),
    entry(11, 'Refresh', 'refresh'),
    separator(),
    ...(desktop ? [] : [entry(12, 'Customize this folder...', 'viewcustomwizard'), separator()]),
    // The windowless view always grays Paste; only the clipboard probe enables it.
    { ...entry(13, 'Paste', 'paste'), disabled: true },
    entry(14, 'Open in Terminal', '{9F156763-7844-4DC4-B2B1-901F640F5155}'),
    separator(),
    submenu('New', [
      entry(15, 'Folder', 'NewFolder'),
      entry(16, 'Shortcut', 'NewLink'),
      separator(),
      entry(17, 'Text Document', '.txt')
    ]),
    separator(),
    ...(desktop
      ? [entry(18, 'Display settings', 'Display'), entry(19, 'Personalize', 'Personalize')]
      : [entry(20, 'Properties', 'properties')])
  ]
}

/** A file menu shaped like the one the spike read for a temp file. */
export function sampleItemsMenu(): ShellMenuItem[] {
  return [
    entry(1, 'Open', 'open'),
    entry(2, 'Copy as path', 'copyaspath'),
    separator(),
    submenu('Send to', [entry(3, 'Compressed (zipped) folder'), entry(4, 'Documents')]),
    separator(),
    entry(5, 'Cut', 'cut'),
    entry(6, 'Copy', 'copy'),
    separator(),
    entry(7, 'Create shortcut', 'link'),
    entry(8, 'Delete', 'delete'),
    entry(9, 'Rename', 'rename'),
    separator(),
    entry(10, 'Properties', 'properties')
  ]
}

function defaultMenus(target: ShellMenuTarget): ShellMenuItem[] {
  if (target.kind === 'items') return sampleItemsMenu()
  return sampleBackgroundMenu(target.kind === 'desktop-background')
}

/** The first item (depth-first) with this label, in a menu as `choose` sees it. */
export function findItem(menu: ShellMenuItem[], label: string): ShellMenuItem | undefined {
  for (const item of menu) {
    if (item.label === label && !item.separator) return item
    const inner = item.submenu ? findItem(item.submenu, label) : undefined
    if (inner) return inner
  }
  return undefined
}

export function createFakeShellMenuApi(options: FakeShellMenuOptions = {}): FakeShellMenuApi {
  const menus = options.menus ?? defaultMenus
  let choose: FakeChoice = options.choose ?? (() => 0)
  let failure: Error | null = null
  let invokeFailure: Error | null = null
  let clipboardPasteable = options.clipboardPasteable ?? false
  let pasteProbes = 0
  /** The model of the koffi paste-state query: Paste enabled when the clipboard is pasteable. */
  const withPasteState = (tree: ShellMenuItem[]): ShellMenuItem[] => {
    pasteProbes++
    const set = (list: ShellMenuItem[]): ShellMenuItem[] =>
      list.map((item) =>
        item.submenu
          ? { ...item, submenu: set(item.submenu) }
          : item.verb === 'paste' || item.verb === 'pastelink'
            ? { ...item, disabled: !clipboardPasteable }
            : item
      )
    return set(tree)
  }
  let foreground = options.foreground ?? true
  const focusReturns: bigint[] = []
  let pumpFailure: Error | null = null
  let pumps = 0
  const invoked: FakeShellMenuApi['invoked'] = []
  const shown: ShowMenuRequest[] = []
  let disposed = false

  const failIfTold = (): void => {
    if (failure === null) return
    const error = failure
    failure = null
    throw error
  }

  const invokedBy: ('id' | 'verb')[] = []
  const invoke = (target: ShellMenuTarget, verb: string | null, by: 'id' | 'verb'): void => {
    if (invokeFailure !== null) {
      const error = invokeFailure
      invokeFailure = null
      throw error
    }
    invoked.push({ target, verb })
    invokedBy.push(by)
  }
  const shape = (request: ShowMenuRequest, pasteState: boolean): ReturnType<typeof shapeMenu> => {
    const tree = menus(request.target, DEFAULT_BACKGROUND_SOURCE)
    const background = request.target.kind !== 'items'
    return shapeMenu(pasteState && background ? withPasteState(tree) : tree, request)
  }

  const api: FakeShellMenuApi = {
    invoked,
    invokedBy,
    shown,
    get disposed() {
      return disposed
    },
    get pumps() {
      return pumps
    },
    failNextPump(error) {
      pumpFailure = error
    },
    pumpMessages() {
      pumps++
      if (pumpFailure === null) return
      const error = pumpFailure
      pumpFailure = null
      throw error
    },
    menuFor: (target, source) => menus(target, source),
    failNext(error) {
      failure = error
    },
    failNextInvoke(error) {
      invokeFailure = error
    },
    get pasteProbes() {
      return pasteProbes
    },
    setClipboardPasteable(pasteable) {
      clipboardPasteable = pasteable
    },
    setChoice(next) {
      choose = next
    },
    setForeground(granted) {
      foreground = granted
    },
    focusReturns,

    enumerate(target, enumerateOptions) {
      failIfTold()
      const tree = menus(target, enumerateOptions.source ?? DEFAULT_BACKGROUND_SOURCE)
      return enumerateOptions.pasteState && target.kind !== 'items' ? withPasteState(tree) : tree
    },

    preview(request) {
      failIfTold()
      return shape(request, false).menu
    },

    show(request, hooks): ShowMenuOutcome {
      failIfTold()
      const shaped = shape(request, true)
      // Like the koffi api: no foreground, no menu (it could not be dismissed).
      if (!foreground) throw new Error(FOREGROUND_REFUSED)
      shown.push(request)
      hooks.onShowing({ ownerHwnd: options.ownerHwnd ?? FAKE_OWNER_HWND })
      const resolution = resolveShown(choose(shaped.menu, request), {
        tree: shaped.shell,
        idByCommand: shaped.idByCommand,
        interceptVerbs: request.interceptVerbs,
        interceptSubmenus: request.interceptSubmenus,
        background: request.target.kind !== 'items'
      })
      const background = request.target.kind !== 'items'
      if (resolution.kind === 'invoke') hooks.onInvoking?.()
      const outcome =
        resolution.kind !== 'invoke'
          ? resolution
          : invokeOutcome(resolution, () =>
              invoke(
                request.target,
                resolution.verb,
                invokesByVerb(resolution.verb, background) ? 'verb' : 'id'
              )
            )
      if (request.returnFocusTo !== undefined && returnsFocus(outcome)) {
        focusReturns.push(BigInt(request.returnFocusTo))
      }
      return outcome
    },

    invokeVerb(target, verb) {
      failIfTold()
      runInvoke(() => invoke(target, verb, 'verb'))
    },

    dispose() {
      disposed = true
    }
  }
  return api
}
