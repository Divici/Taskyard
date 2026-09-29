import { z } from 'zod'
import {
  SHELL_MENU_IPC,
  type ShellMenuFallbackReason,
  type ShellMenuShowRequest,
  type ShellMenuShowResult
} from '@shared/ipc'
import type { Point } from '@shared/schema'
import { backgroundMenuPolicy, newItemPlacement } from '@shared/shell-menu'
import { handleTrusted, type IpcMainLike, type TrustedHandlerOptions } from '../ipc/sender-guard'
import type { DesktopViewCommand, Hwnd } from '../win32/api'
import { ShellMenuError, type ShellMenuHost } from './host'
import type { NewItemTracker } from './new-item-tracker'

/**
 * Native menus, Phase 3: the empty desktop's right-click. The renderer says where it was clicked
 * and what its Taskyard items should tick; main turns that into the helper's request for the
 * real Desktop background menu (always the Desktop namespace root, so Paste and New ▸ act on the
 * user's Desktop folder), shows it, and answers what became of it. Any failure before the menu
 * showed answers `fallback`, and the renderer opens Taskyard's own menu at the same point.
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

const fallback = (reason: ShellMenuFallbackReason): ShellMenuShowResult => ({
  kind: 'fallback',
  reason
})

export function createCanvasMenuService(deps: CanvasMenuServiceDeps): CanvasMenuService {
  const { log } = deps

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
      const screen = deps.dipToScreenPoint({
        x: window.origin.x + request.point.x,
        y: window.origin.y + request.point.y
      })
      // A Peek stays up while the menu is (the helper's hidden owner window has the foreground).
      const release = deps.peek()?.holdForMenu() ?? (() => {})
      try {
        const outcome = await host.show({
          target: { kind: 'desktop-background' },
          point: { x: Math.round(screen.x), y: Math.round(screen.y) },
          extendedVerbs: request.extendedVerbs,
          ...backgroundMenuPolicy(request.state),
          returnFocusTo: String(window.hwnd)
        })
        if (outcome.kind === 'invoked') {
          const placement = newItemPlacement(outcome.verb)
          if (placement) {
            deps.newItems.expect({
              displayId: request.displayId,
              point: { ...request.point },
              rename: placement.rename
            })
          }
        }
        const viewCommand =
          outcome.kind === 'intercepted' ? desktopViewCommandFor(outcome.verb) : null
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

const RequestSchema = z.strictObject({
  kind: z.literal('background'),
  displayId: z.number().int(),
  point: z.strictObject({ x: z.number().finite(), y: z.number().finite() }),
  extendedVerbs: z.boolean(),
  state: z.strictObject({
    iconSize: z.enum(['small', 'medium', 'large']),
    gridSnap: z.boolean(),
    quickHidden: z.boolean(),
    toolsShown: z.boolean()
  })
})

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
