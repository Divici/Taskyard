import { z } from 'zod'
import type {
  ShellMenuItem,
  ShellMenuTarget,
  ShowMenuOutcome,
  ShowMenuRequest,
  TaskyardMenuItem
} from '../win32/shell-menu-api'

/**
 * The messages between Taskyard's main process (host.ts) and the shell-menu helper (helper.ts),
 * sent over the utility process's MessagePort (`child.postMessage` / `process.parentPort`). Both
 * directions are validated: the helper hosts third-party shell extensions, so main never trusts
 * what comes back unchecked.
 *
 * main → helper: `show` | `enumerate` | `invoke`, each with a request `id`; `shutdown`.
 * helper → main: `ready` once at start (or `fatal`), `showing` when a show request's menu is on
 * screen, then exactly one `result` or `error` per request; `crash` for an error outside a
 * request and `warn` for a recovered problem (the helper keeps running either way).
 */

const pathString = z.string().min(1).max(32_767)
const verbString = z.string().min(1).max(260)

const targetSchema: z.ZodType<ShellMenuTarget> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('desktop-background') }),
  z.object({ kind: z.literal('folder-background'), path: pathString }),
  z.object({ kind: z.literal('items'), paths: z.array(pathString).min(1).max(10_000) })
])

const labelSourceSchema = z.union([
  z.object({ verb: verbString }),
  z.object({ submenu: verbString, index: z.number().int().nonnegative().max(500) })
])

const taskyardItemSchema: z.ZodType<TaskyardMenuItem> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('item'),
      id: z.string().min(1).max(200),
      label: z.string().min(1).max(260),
      disabled: z.boolean().optional(),
      checked: z.boolean().optional(),
      radio: z.boolean().optional(),
      labelFrom: labelSourceSchema.optional()
    }),
    z.object({
      kind: z.literal('submenu'),
      label: z.string().min(1).max(260),
      items: z.array(taskyardItemSchema).max(500)
    }),
    z.object({ kind: z.literal('separator') })
  ])
)

const requestId = z.number().int().positive()
const point = z.object({ x: z.number().int(), y: z.number().int() })
const verbList = z.array(verbString).max(500)
const replacementSchema = z.object({
  match: z.union([z.object({ verb: verbString }), z.object({ label: z.string().min(1).max(260) })]),
  label: z.string().min(1).max(260).optional(),
  items: z.array(taskyardItemSchema).max(500)
})

const showRequestSchema = z.object({
  type: z.literal('show'),
  id: requestId,
  target: targetSchema,
  point,
  extendedVerbs: z.boolean(),
  taskyardItems: z.array(taskyardItemSchema).max(500),
  interceptVerbs: verbList,
  interceptSubmenus: verbList,
  hideVerbs: verbList,
  hideSubmenus: verbList,
  replaceSubmenus: z.array(replacementSchema).max(50),
  /** The HWND as a decimal string (like `showing.ownerHwnd`). */
  returnFocusTo: z.string().regex(/^\d+$/).max(20).optional()
})

const helperRequestSchema = z.discriminatedUnion('type', [
  showRequestSchema,
  z.object({
    type: z.literal('enumerate'),
    id: requestId,
    target: targetSchema,
    extendedVerbs: z.boolean(),
    source: z.enum(['shell-view', 'view-object', 'default-menu']).optional(),
    pasteState: z.boolean().optional()
  }),
  z.object({ type: z.literal('invoke'), id: requestId, target: targetSchema, verb: verbString }),
  /** Dispose the api (flushing the OLE clipboard, so a Copy outlives the helper) and exit. */
  z.object({ type: z.literal('shutdown') })
])

export type HelperRequest = z.infer<typeof helperRequestSchema>
export type ShowHelperRequest = Extract<HelperRequest, { type: 'show' }>

// The show request carries a ShowMenuRequest; keep the two in step at compile time.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const showRequestMatches: Same<Omit<ShowHelperRequest, 'type' | 'id'>, ShowMenuRequest> = true
void showRequestMatches

const shellMenuItemSchema: z.ZodType<ShellMenuItem> = z.lazy(() =>
  z.object({
    id: z.number().int().nonnegative(),
    label: z.string(),
    accelerator: z.string().nullable(),
    verb: z.string().nullable(),
    separator: z.boolean(),
    disabled: z.boolean(),
    checked: z.boolean(),
    radio: z.boolean().optional(),
    submenu: z.array(shellMenuItemSchema).nullable()
  })
)

const labelPath = z.array(z.string())
const outcomeSchema: z.ZodType<ShowMenuOutcome> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dismissed') }),
  z.object({ kind: z.literal('taskyard'), id: z.string().min(1) }),
  z.object({
    kind: z.literal('intercepted'),
    verb: z.string().nullable(),
    label: z.string(),
    path: labelPath
  }),
  z.object({
    kind: z.literal('invoke-failed'),
    verb: z.string().nullable(),
    label: z.string(),
    path: labelPath,
    message: z.string()
  }),
  z.object({
    kind: z.literal('invoked'),
    verb: z.string().nullable(),
    label: z.string(),
    path: labelPath
  })
])

const helperMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), pid: z.number().int().positive() }),
  z.object({ type: z.literal('fatal'), message: z.string() }),
  /** `ownerHwnd`: the HWND as a decimal string (BigInt does not cross every channel). */
  z.object({ type: z.literal('showing'), id: requestId, ownerHwnd: z.string().regex(/^\d+$/) }),
  z.object({
    type: z.literal('result'),
    id: requestId,
    result: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('show'), outcome: outcomeSchema }),
      z.object({ kind: z.literal('enumerate'), items: z.array(shellMenuItemSchema) }),
      z.object({ kind: z.literal('invoke') })
    ])
  }),
  z.object({ type: z.literal('error'), id: requestId, message: z.string() }),
  z.object({ type: z.literal('crash'), message: z.string() }),
  /** Something went wrong but the helper carried on (a failed cleanup, a handler that threw). */
  z.object({ type: z.literal('warn'), message: z.string() })
])

export type HelperMessage = z.infer<typeof helperMessageSchema>

/** Validates a request arriving in the helper; throws a ZodError when it is malformed. */
export function parseHelperRequest(message: unknown): HelperRequest {
  return helperRequestSchema.parse(message)
}

/** Validates a message arriving in main from the helper; throws when it is malformed. */
export function parseHelperMessage(message: unknown): HelperMessage {
  return helperMessageSchema.parse(message)
}
