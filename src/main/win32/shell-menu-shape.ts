import { ComError } from './com'
import {
  placeTaskyardItems,
  pruneMenu,
  resolveCommand,
  splitMenuText,
  type CommandResolution,
  type LabelSource,
  type PlacedTaskyardItem,
  type ShellMenuItem,
  type ShowMenuOutcome,
  type ShowMenuRequest,
  type SubmenuMatch,
  type TaskyardMenuItem
} from './shell-menu-api'

/**
 * Shaping a native menu for Taskyard, as pure functions over item trees: Windows' own labels for
 * Taskyard items, Taskyard submenus in place of shell ones, and what a failed invoke means. The
 * fake applies them to its scripted tree; the koffi implementation applies the same rules to the
 * real HMENU (and resolves commands with the same `resolveCommand`).
 */

/** HRESULT_FROM_WIN32(ERROR_CANCELLED): the user cancelled a UAC prompt or a dialog. */
export const HRESULT_ERROR_CANCELLED = 0x800704c7 | 0

const normalLabel = (label: string): string => splitMenuText(label).label.trim().toLowerCase()

/** True when `item` is a submenu matched by `match` (a verb it holds, or its label). */
export function matchesSubmenu(item: ShellMenuItem, match: SubmenuMatch): boolean {
  if (item.submenu === null) return false
  if ('verb' in match) return item.submenu.some((child) => child.verb === match.verb)
  return normalLabel(item.label) === normalLabel(match.label)
}

/** The first submenu (depth-first) matched by `match`. */
export function findSubmenu(tree: ShellMenuItem[], match: SubmenuMatch): ShellMenuItem | undefined {
  for (const item of tree) {
    if (matchesSubmenu(item, match)) return item
    const inner = item.submenu ? findSubmenu(item.submenu, match) : undefined
    if (inner) return inner
  }
  return undefined
}

function findVerb(tree: ShellMenuItem[], verb: string): ShellMenuItem | undefined {
  for (const item of tree) {
    if (item.submenu === null && item.verb === verb) return item
    const inner = item.submenu ? findVerb(item.submenu, verb) : undefined
    if (inner) return inner
  }
  return undefined
}

/** Windows' label for `source` in `tree`, or null when there is no such item. */
export function labelFor(tree: ShellMenuItem[], source: LabelSource): string | null {
  if ('verb' in source) return findVerb(tree, source.verb)?.label ?? null
  const submenu = findSubmenu(tree, { verb: source.submenu })
  const entries = (submenu?.submenu ?? []).filter((item) => !item.separator)
  return entries[source.index]?.label ?? null
}

/** Taskyard items with every `labelFrom` resolved against the shell menu (fallback: `label`). */
export function resolveLabels(
  items: TaskyardMenuItem[],
  tree: ShellMenuItem[]
): TaskyardMenuItem[] {
  return items.map((item) => {
    if (item.kind === 'submenu') return { ...item, items: resolveLabels(item.items, tree) }
    if (item.kind !== 'item' || !item.labelFrom) return item
    return { ...item, label: labelFor(tree, item.labelFrom) ?? item.label }
  })
}

export interface PlacedReplacement {
  match: SubmenuMatch
  label?: string
  items: PlacedTaskyardItem[]
}

/**
 * Numbers the top items, then each replacement's, from TASKYARD_COMMAND_BASE with one id map (a
 * click anywhere maps back to its stable id; an id used twice is refused).
 */
export function placeTaskyardMenus(
  top: TaskyardMenuItem[],
  replacements: { match: SubmenuMatch; label?: string; items: TaskyardMenuItem[] }[]
): {
  top: PlacedTaskyardItem[]
  replacements: PlacedReplacement[]
  idByCommand: Map<number, string>
} {
  const placed = placeTaskyardItems([
    ...top,
    ...replacements.map((replacement): TaskyardMenuItem => ({
      kind: 'submenu',
      label: '',
      items: replacement.items
    }))
  ])
  return {
    top: placed.items.slice(0, top.length),
    replacements: replacements.map((replacement, index) => {
      const holder = placed.items[top.length + index]
      return {
        match: replacement.match,
        ...(replacement.label !== undefined ? { label: replacement.label } : {}),
        items: holder.kind === 'submenu' ? holder.items : []
      }
    }),
    idByCommand: placed.idByCommand
  }
}

function entry(id: number, label: string): ShellMenuItem {
  return {
    id,
    label,
    accelerator: null,
    verb: null,
    separator: false,
    disabled: false,
    checked: false,
    submenu: null
  }
}

/** Placed Taskyard items as menu entries (what they look like once inserted). */
export function placedToItems(items: PlacedTaskyardItem[]): ShellMenuItem[] {
  return items.map((item) => {
    if (item.kind === 'separator') return { ...entry(0, ''), separator: true }
    if (item.kind === 'submenu')
      return { ...entry(0, item.label), submenu: placedToItems(item.items) }
    return {
      ...entry(item.command, item.label),
      disabled: item.disabled,
      checked: item.checked,
      ...(item.radio ? { radio: true } : {})
    }
  })
}

/** `tree` with each matched submenu's items swapped for the replacement's (first match each). */
export function replaceSubmenus(
  tree: ShellMenuItem[],
  replacements: PlacedReplacement[]
): ShellMenuItem[] {
  const pending = [...replacements]
  const walk = (list: ShellMenuItem[]): ShellMenuItem[] =>
    list.map((item) => {
      if (item.submenu === null) return item
      const index = pending.findIndex((replacement) => matchesSubmenu(item, replacement.match))
      if (index < 0) return { ...item, submenu: walk(item.submenu) }
      const [replacement] = pending.splice(index, 1)
      return {
        ...item,
        label: replacement.label ?? item.label,
        submenu: placedToItems(replacement.items)
      }
    })
  return walk(tree)
}

/** A request's Taskyard items with Windows' labels, numbered, and the shell tree reshaped. */
export function shapeMenu(
  shellTree: ShellMenuItem[],
  request: Pick<ShowMenuRequest, 'taskyardItems' | 'replaceSubmenus' | 'hideVerbs' | 'hideSubmenus'>
): {
  menu: ShellMenuItem[]
  shell: ShellMenuItem[]
  top: PlacedTaskyardItem[]
  replacements: PlacedReplacement[]
  idByCommand: Map<number, string>
} {
  const placed = placeTaskyardMenus(
    resolveLabels(request.taskyardItems, shellTree),
    request.replaceSubmenus.map((replacement) => ({
      ...replacement,
      items: resolveLabels(replacement.items, shellTree)
    }))
  )
  const shell = pruneMenu(replaceSubmenus(shellTree, placed.replacements), request)
  const top = placedToItems(placed.top)
  const menu =
    top.length > 0 && shell.length > 0
      ? [...top, { ...entry(0, ''), separator: true }, ...shell]
      : [...top, ...shell]
  return {
    menu,
    shell,
    top: placed.top,
    replacements: placed.replacements,
    idByCommand: placed.idByCommand
  }
}

function isCancelled(error: unknown): boolean {
  return error instanceof ComError && error.hresult === HRESULT_ERROR_CANCELLED
}

/** Runs an invoke; a cancel (ERROR_CANCELLED) is not a failure, anything else is rethrown. */
export function runInvoke(run: () => void): void {
  try {
    run()
  } catch (error) {
    if (!isCancelled(error)) throw error
  }
}

/** The outcome of invoking the chosen shell item: invoked, or invoke-failed with the reason. */
export function invokeOutcome(
  chosen: Extract<CommandResolution, { kind: 'invoke' }>,
  run: () => void
): ShowMenuOutcome {
  const { verb, label, path } = chosen
  try {
    runInvoke(run)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'invoke-failed', verb, label, path, message }
  }
  return { kind: 'invoked', verb, label, path }
}

/** `resolveCommand` with the view-state guard on for background targets. */
export function resolveShown(
  command: number,
  context: Omit<Parameters<typeof resolveCommand>[1], 'guardViewState'> & { background: boolean }
): CommandResolution {
  const { background, ...rest } = context
  return resolveCommand(command, { ...rest, guardViewState: background })
}
