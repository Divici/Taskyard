import { z } from 'zod'
import {
  SHELL_MENU_IPC,
  type ShellMenuFallbackReason,
  type ShellMenuShowRequest,
  type ShellMenuShowResult
} from '@shared/ipc'
import { FileIdSchema, type Point } from '@shared/schema'
import {
  backgroundMenuPolicy,
  itemMenuPlacement,
  itemMenuPolicy,
  newItemPlacement,
  type ShellMenuPolicy
} from '@shared/shell-menu'
import { handleTrusted, type IpcMainLike, type TrustedHandlerOptions } from '../ipc/sender-guard'
import type { DesktopViewCommand, Hwnd } from '../win32/api'
import type { ShellMenuTarget, ShowMenuOutcome } from '../win32/shell-menu-api'
import { ShellMenuError, type ShellMenuHost } from './host'
import type { NewItemTracker } from './new-item-tracker'

/**
 * Native menus, Phase 3: the empty desktop's right-click. The renderer says where it was clicked
 * and what its Taskyard items should tick; main turns that into the helper's request for the
 * real Desktop background menu (always the Desktop namespace root, so Paste and New ▸ act on the
 * user's Desktop folder), shows it, and answers what became of it. Any failure before the menu
 * showed answers `fallback`, and the renderer opens Taskyard's own menu at the same point.
 *
 * Phase 4: the same for a right-click on icons. The renderer names the item ids (right-clicked
 * first); main looks up their current paths in its own desktop model and asks for Windows' file
 * menu of those files, with Taskyard's item policy (Remove from group, Copy path, Rename
 * intercepted).
 */

/** The desktop window a request came from. */
export interface CanvasMenuWindow {
  displayId: number
  hwnd: Hwnd
  /** The window's top-left corner in screen DIPs (its display's bounds). */
  origin: Point
}

export interface CanvasMenuServiceDeps {
  /** The shell-menu host; null when native menus are off (fake Win32, TASKYARD_FAKE_SHELL_MENU=0). */
  host(): Pick<ShellMenuHost, 'show' | 'cancelShows'> | null
  /** The desktop window whose renderer has this webContents id, or null. */
  windowOf(senderId: number): CanvasMenuWindow | null
  /** `screen.dipToScreenPoint`: screen DIPs → physical pixels (what TrackPopupMenuEx takes). */
  dipToScreenPoint(point: Point): Point
  /** The window manager (Peek), or null before the desktop windows exist. */
  peek(): { holdForMenu(): () => void } | null
  newItems: Pick<NewItemTracker, 'expect'>
  /** Win32Api.desktopViewCommand: Undo / Paste through Explorer's own desktop view. */
  desktopViewCommand(command: DesktopViewCommand): boolean
  /**
   * Phase 4: the current path of each item id in main's desktop model (null: not known), in
   * order. The renderer names ids only. Called when the helper takes the request (review fix:
   * a rename while an earlier menu was open is seen).
   */
  itemPaths(ids: readonly string[]): (string | null)[]
  log: { warn(message: string, ...details: unknown[]): void }
}

export interface CanvasMenuService {
  /** Whether a native menu can show at all (else the renderer opens its own at once). */
  available(): boolean
  show(senderId: number, request: ShellMenuShowRequest): Promise<ShellMenuShowResult>
}

/** The intercepted verbs Explorer's own desktop view runs (the windowless view ignores them). */
function desktopViewCommandFor(verb: string | null): DesktopViewCommand | null {
  return verb === 'undo' || verb === 'paste' ? verb : null
}

/** What one kind of native menu shows and what main does with its outcome. */
interface MenuPlan {
  /** Read when the helper takes the request; throws UnknownItemsError for a gone item. */
  target(): ShellMenuTarget
  policy: ShellMenuPolicy
  /** New Desktop items the chosen command makes, placed at the right-click point. */
  placement(outcome: ShowMenuOutcome): { rename: boolean } | null
  /** Undo / Paste intercepted on the Desktop background run through Explorer's own view. */
  viewCommands: boolean
}

/** The right-clicked item is not in main's desktop model (any more). */
class UnknownItemsError extends Error {
  constructor(readonly id: string) {
    super(`no file menu for ${id}, which main does not know`)
    this.name = 'UnknownItemsError'
  }
}

const fallback = (reason: ShellMenuFallbackReason): ShellMenuShowResult => ({
  kind: 'fallback',
  reason
})

export function createCanvasMenuService(deps: CanvasMenuServiceDeps): CanvasMenuService {
  const { log } = deps

  /** The Desktop background menu's request, and what main does with its outcome. */
  const background = (
    request: Extract<ShellMenuShowRequest, { kind: 'background' }>
  ): MenuPlan => ({
    target: () => ({ kind: 'desktop-background' }),
    policy: backgroundMenuPolicy(request.state),
    placement: (outcome) => (outcome.kind === 'invoked' ? newItemPlacement(outcome.verb) : null),
    viewCommands: true
  })

  /** An icon's file menu: the items' current paths from main's model (right-clicked first). */
  const items = (request: Extract<ShellMenuShowRequest, { kind: 'items' }>): MenuPlan => ({
    target: () => {
      const paths = deps.itemPaths(request.ids)
      const [clicked] = paths
      if (clicked === null || clicked === undefined) throw new UnknownItemsError(request.ids[0])
      return { kind: 'items', paths: paths.filter((path): path is string => path !== null) }
    },
    policy: itemMenuPolicy(request.state),
    placement: (outcome) => (outcome.kind === 'invoked' ? itemMenuPlacement(outcome.verb) : null),
    viewCommands: false
  })

  return {
    available: () => deps.host() !== null,

    async show(senderId, request) {
      const host = deps.host()
      if (host === null) return fallback('unavailable')
      const window = deps.windowOf(senderId)
      if (window === null || window.displayId !== request.displayId) {
        log.warn(
          `shell-menu: a menu request from webContents ${senderId} names display ${request.displayId}, which is not its window's`
        )
        return fallback('unknown-window')
      }
      // A new right-click replaces the menu before it (open: dismissed; queued: never shown).
      host.cancelShows()
      const plan = request.kind === 'background' ? background(request) : items(request)
      const screen = deps.dipToScreenPoint({
        x: window.origin.x + request.point.x,
        y: window.origin.y + request.point.y
      })
      // A Peek stays up while the menu is (the helper's hidden owner window has the foreground).
      const release = deps.peek()?.holdForMenu() ?? (() => {})
      try {
        // Built when the helper takes it (an icon menu's paths are looked up then).
        const outcome = await host.show(() => ({
          target: plan.target(),
          point: { x: Math.round(screen.x), y: Math.round(screen.y) },
          extendedVerbs: request.extendedVerbs,
          ...plan.policy,
          returnFocusTo: String(window.hwnd)
        }))
        const placement = plan.placement(outcome)
        if (placement) {
          deps.newItems.expect({
            displayId: request.displayId,
            point: { ...request.point },
            rename: placement.rename
          })
        }
        const viewCommand =
          outcome.kind === 'intercepted' && plan.viewCommands
            ? desktopViewCommandFor(outcome.verb)
            : null
        if (outcome.kind === 'intercepted' && viewCommand !== null) {
          if (!deps.desktopViewCommand(viewCommand)) {
            const message = 'Explorer’s desktop is not running.'
            log.warn(`shell-menu: "${outcome.label}" could not run`, message)
            return { ...outcome, kind: 'invoke-failed', message }
          }
          // Explorer pastes into the user's Desktop folder: the items go to the right-click point.
          if (viewCommand === 'paste') {
            deps.newItems.expect({
              displayId: request.displayId,
              point: { ...request.point },
              rename: false
            })
          }
        }
        if (outcome.kind === 'invoke-failed') {
          log.warn(
            `shell-menu: "${outcome.label}" (${outcome.verb ?? 'no verb'}) failed`,
            outcome.message
          )
        }
        return outcome
      } catch (error) {
        if (error instanceof ShellMenuError && error.code === 'cancelled')
          return { kind: 'superseded' }
        if (error instanceof UnknownItemsError) {
          log.warn(`shell-menu: ${error.message}`)
          return fallback('unknown-items')
        }
        const reason: ShellMenuFallbackReason =
          error instanceof ShellMenuError && error.code !== 'cancelled'
            ? error.code
            : 'request-failed'
        const message = error instanceof Error ? error.message : String(error)
        log.warn(`shell-menu: no native menu (${reason}); showing Taskyard's menu`, message)
        return fallback(reason)
      } finally {
        release()
      }
    }
  }
}

const menuPoint = z.strictObject({ x: z.number().finite(), y: z.number().finite() })

const RequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('background'),
    displayId: z.number().int(),
    point: menuPoint,
    extendedVerbs: z.boolean(),
    state: z.strictObject({
      iconSize: z.enum(['small', 'medium', 'large']),
      gridSnap: z.boolean(),
      quickHidden: z.boolean(),
      toolsShown: z.boolean()
    })
  }),
  // Phase 4: an icon's file menu names item ids (main's model resolves them), never paths.
  z.strictObject({
    kind: z.literal('items'),
    displayId: z.number().int(),
    point: menuPoint,
    extendedVerbs: z.boolean(),
    ids: z.array(FileIdSchema).min(1).max(10_000),
    state: z.strictObject({ inGroup: z.boolean(), canRename: z.boolean() })
  })
])

const Args = {
  show: z.tuple([RequestSchema]),
  none: z.tuple([])
}

/** `shellMenu:show` and `shellMenu:available`, for the Taskyard renderer only. Returns the remover. */
export function registerShellMenuIpc(
  ipc: IpcMainLike,
  trust: TrustedHandlerOptions,
  service: CanvasMenuService
): () => void {
  const parse = <T>(channel: string, schema: z.ZodType<T>, args: unknown[]): T => {
    const result = schema.safeParse(args)
    if (result.success) return result.data
    trust.log.warn(`ipc: invalid arguments for ${channel}`, z.prettifyError(result.error))
    throw new Error(`invalid arguments for ${channel}`)
  }

  handleTrusted(ipc, SHELL_MENU_IPC.show, trust, (event, args) => {
    const [request] = parse(SHELL_MENU_IPC.show, Args.show, args)
    return service.show(event.sender.id, request)
  })
  handleTrusted(ipc, SHELL_MENU_IPC.available, trust, (_event, args) => {
    parse(SHELL_MENU_IPC.available, Args.none, args)
    return service.available()
  })

  return () => {
    for (const channel of Object.values(SHELL_MENU_IPC)) ipc.removeHandler(channel)
  }
}
