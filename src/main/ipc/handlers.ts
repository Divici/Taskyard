import { z } from 'zod'
import {
  EXTERNAL_URL_PROTOCOLS,
  IPC,
  STORE_NAMES,
  type SaveResult,
  type StoreName
} from '@shared/ipc'
import { parseExact } from '../storage/exact-parse'
import { STORE_SCHEMAS, type Storage } from '../storage/stores'
import { handleTrusted, type IpcInvokeEventLike, type IpcMainLike } from './sender-guard'

export type { IpcInvokeEventLike, IpcMainLike } from './sender-guard'

export interface HandlerDeps {
  /** Accepted saves reach every window through the storage `onChange` hook (see index.ts). */
  storage: Pick<Storage, 'store' | 'status'>
  isTrustedSender: (event: IpcInvokeEventLike) => boolean
  /** `shell.openExternal`; only ever receives an allow-listed, normalised URL. */
  openExternal: (url: string) => Promise<void>
  quit: () => void
  log: { warn(message: string, ...details: unknown[]): void }
}

/** Channels registered here. `display:get`/`display:list` are the window manager's (Phase 2). */
export const HANDLED_CHANNELS = [
  IPC.storage.load,
  IPC.storage.save,
  IPC.storage.status,
  IPC.app.quit,
  IPC.app.openExternal
] as const

const MAX_URL_LENGTH = 2048

const StoreNameSchema = z.enum(STORE_NAMES)

/** Allow-listed schemes only (`ms-settings:`, `https:`); returns the normalised href. */
export const ExternalUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH)
  .transform((value, ctx) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'not a URL' })
      return z.NEVER
    }
    if (!(EXTERNAL_URL_PROTOCOLS as readonly string[]).includes(url.protocol)) {
      ctx.addIssue({ code: 'custom', message: `scheme ${url.protocol} is not allowed` })
      return z.NEVER
    }
    return url.href
  })

const SaveRequestSchema = z.strictObject({
  baseRevision: z.number().int().nonnegative(),
  data: z.unknown()
})

const Args = {
  storeName: z.tuple([StoreNameSchema]),
  save: z.tuple([StoreNameSchema, SaveRequestSchema]),
  none: z.tuple([]),
  url: z.tuple([ExternalUrlSchema])
}

/**
 * Registers the main-side request handlers. Every call is checked twice before it does anything:
 * the sender must be the Taskyard renderer, and every argument must pass its zod schema.
 * Returns a disposer that removes the handlers.
 */
export function registerIpcHandlers(ipc: IpcMainLike, deps: HandlerDeps): () => void {
  function reject(channel: string, reason: string): never {
    deps.log.warn(`ipc: invalid arguments for ${channel}`, reason)
    throw new Error(`invalid arguments for ${channel}`)
  }

  function parse<T>(channel: string, schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value)
    return result.success ? result.data : reject(channel, z.prettifyError(result.error))
  }

  function handle(
    channel: (typeof HANDLED_CHANNELS)[number],
    handler: (event: IpcInvokeEventLike, args: unknown[]) => unknown
  ): void {
    handleTrusted(ipc, channel, deps, handler)
  }

  handle(IPC.storage.load, (_event, args) => {
    const [store] = parse(IPC.storage.load, Args.storeName, args)
    return deps.storage.store(store).snapshot()
  })

  function save<N extends StoreName>(store: N, baseRevision: number, raw: unknown): SaveResult<N> {
    // Exact: a missing field anywhere is refused, never filled with a default.
    const parsed = parseExact(STORE_SCHEMAS[store], raw)
    if (!parsed.success) return reject(IPC.storage.save, parsed.error)
    return deps.storage.store(store).save(parsed.data, baseRevision)
  }

  handle(IPC.storage.save, (_event, args) => {
    const [store, { baseRevision, data }] = parse(IPC.storage.save, Args.save, args)
    return save(store, baseRevision, data)
  })

  handle(IPC.storage.status, (_event, args) => {
    parse(IPC.storage.status, Args.none, args)
    return deps.storage.status()
  })

  handle(IPC.app.quit, (_event, args) => {
    parse(IPC.app.quit, Args.none, args)
    deps.quit()
  })

  handle(IPC.app.openExternal, async (_event, args) => {
    const [url] = parse(IPC.app.openExternal, Args.url, args)
    await deps.openExternal(url)
  })

  return () => {
    for (const channel of HANDLED_CHANNELS) ipc.removeHandler(channel)
  }
}
