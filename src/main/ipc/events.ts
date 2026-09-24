import type { IpcEventName, IpcEvents } from '@shared/ipc'

/** The slice of `WebContents` needed to push an event to a renderer. */
export interface WebContentsLike {
  id: number
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export interface EventLog {
  warn(message: string, ...details: unknown[]): void
}

export interface IpcEventEmitter {
  /**
   * Sends a typed main → renderer event to every live renderer; returns how many it reached.
   * There is deliberately no way to skip one: a window must see its own saves echoed, or it
   * falls out of step with the revision everyone else is on.
   */
  emit<E extends IpcEventName>(event: E, payload: IpcEvents[E]): number
}

/** A broadcast over targets that are not bare renderers (e.g. the desktop windows). */
export interface TargetedEventEmitter<T> extends IpcEventEmitter {
  /** Sends each target its own payload (null skips that target), e.g. each window its display. */
  emitEach<E extends IpcEventName>(event: E, payloadFor: (target: T) => IpcEvents[E] | null): number
  /** Sends to one target, isolated the same way; false when it was not delivered. */
  emitTo<E extends IpcEventName>(target: T, event: E, payload: IpcEvents[E]): boolean
}

/**
 * The one place a main → renderer event is sent. A destroyed renderer is skipped; one whose
 * `send` throws (a frame being torn down) is logged and skipped, never thrown into the caller.
 */
export function sendEvent<E extends IpcEventName>(
  contents: WebContentsLike | null,
  event: E,
  payload: IpcEvents[E],
  log: EventLog
): boolean {
  if (contents === null || contents.isDestroyed()) return false
  try {
    contents.send(event, payload)
    return true
  } catch (error) {
    log.warn(`ipc: sending ${event} to window ${contents.id} failed`, error)
    return false
  }
}

/**
 * Broadcasts to whatever `targets` returns at the moment of each emit, so windows opened or
 * closed since are always accounted for. With `contentsOf`, targets can be anything that owns a
 * renderer (the desktop windows); it returns null for one whose window is gone.
 */
export function createEventEmitter(
  targets: () => Iterable<WebContentsLike>,
  log: EventLog
): TargetedEventEmitter<WebContentsLike>
export function createEventEmitter<T>(
  targets: () => Iterable<T>,
  contentsOf: (target: T) => WebContentsLike | null,
  log: EventLog
): TargetedEventEmitter<T>
export function createEventEmitter<T>(
  targets: () => Iterable<T>,
  contentsOrLog: ((target: T) => WebContentsLike | null) | EventLog,
  maybeLog?: EventLog
): TargetedEventEmitter<T> {
  const contentsOf =
    typeof contentsOrLog === 'function'
      ? contentsOrLog
      : (target: T) => target as unknown as WebContentsLike
  const log = typeof contentsOrLog === 'function' ? maybeLog! : contentsOrLog

  const emitTo = <E extends IpcEventName>(target: T, event: E, payload: IpcEvents[E]): boolean =>
    sendEvent(contentsOf(target), event, payload, log)

  const emitEach = <E extends IpcEventName>(
    event: E,
    payloadFor: (target: T) => IpcEvents[E] | null
  ): number => {
    let delivered = 0
    for (const target of targets()) {
      const payload = payloadFor(target)
      if (payload !== null && emitTo(target, event, payload)) delivered += 1
    }
    return delivered
  }

  return {
    emit: (event, payload) => emitEach(event, () => payload),
    emitEach,
    emitTo
  }
}
