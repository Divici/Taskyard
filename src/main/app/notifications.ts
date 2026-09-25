import { z } from 'zod'
import { TIMER_IPC, type TimerNotifyRequest } from '@shared/ipc'
import type { SettingsFile } from '@shared/schema'
import { handleTrusted, type IpcMainLike, type TrustedHandlerOptions } from '../ipc/sender-guard'

/** What main hands Electron's `new Notification(...)`. */
export interface NotificationOptionsLike {
  title: string
  body: string
  /** The renderer plays its own chime (Settings › Timer sound), so Windows stays quiet. */
  silent: boolean
}

export interface TimerNotifierDeps {
  /** Settings as main holds them now (read when a timer finishes). */
  settings: () => Pick<SettingsFile, 'timerNotify'>
  /** `new Notification(options)`; injectable so tests never load Electron. */
  createNotification: (options: NotificationOptionsLike) => { show(): void }
  /** `Notification.isSupported()`. */
  isSupported: () => boolean
  log: { warn(message: string, ...details: unknown[]): void; info(message: string): void }
}

export interface TimerNotifier {
  /** Shows "Timer finished" unless Settings turn it off or this countdown was already shown. */
  notify(request: TimerNotifyRequest): boolean
}

/** Title and body of the "Timer finished" notification. */
export function timerNotificationContent(taskText?: string): { title: string; body: string } {
  return {
    title: 'Timer finished',
    body: taskText ? `Time’s up for “${taskText}”.` : 'Your countdown has ended.'
  }
}

export function createTimerNotifier(deps: TimerNotifierDeps): TimerNotifier {
  /** The last countdown announced: every window reports the same `endsAt` at most once. */
  let lastEndsAt: number | null = null

  return {
    notify({ endsAt, taskText }) {
      if (endsAt === lastEndsAt) return false
      lastEndsAt = endsAt
      if (!deps.settings().timerNotify) return false
      if (!deps.isSupported()) {
        deps.log.warn('timer: Windows notifications are not supported here')
        return false
      }
      deps.createNotification({ ...timerNotificationContent(taskText), silent: true }).show()
      deps.log.info('timer: finished; notification shown')
      return true
    }
  }
}

/** The request `timer:notify` accepts; anything else is refused before it is shown. */
export const TimerNotifyRequestSchema = z.strictObject({
  endsAt: z.number().int().nonnegative(),
  taskText: z.string().min(1).max(500).optional()
})

const NotifyArgs = z.tuple([TimerNotifyRequestSchema])

/** `timer:notify` for the Taskyard renderer only, with a zod-validated argument. */
export function registerTimerIpc(
  ipcMain: IpcMainLike,
  notifier: TimerNotifier,
  trust: TrustedHandlerOptions
): () => void {
  handleTrusted(ipcMain, TIMER_IPC.notify, trust, (_event, args) => {
    const parsed = NotifyArgs.safeParse(args)
    if (!parsed.success) {
      trust.log.warn(
        `ipc: invalid arguments for ${TIMER_IPC.notify}`,
        z.prettifyError(parsed.error)
      )
      throw new Error(`invalid arguments for ${TIMER_IPC.notify}`)
    }
    const [request] = parsed.data
    return notifier.notify(request)
  })
  return () => ipcMain.removeHandler(TIMER_IPC.notify)
}
