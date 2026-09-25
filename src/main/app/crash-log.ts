// Unhandled main-process errors are logged and the app keeps running (Phase 11): one failing
// callback (a watcher, a timer, a koffi call) must not take the desktop away. Node's default for
// an uncaught exception is to exit; a listener replaces that.

/** The slice of `process` used here (an EventEmitter in tests). */
export interface ProcessLike {
  on(
    event: 'uncaughtException' | 'unhandledRejection',
    listener: (reason: unknown) => void
  ): unknown
  removeListener(
    event: 'uncaughtException' | 'unhandledRejection',
    listener: (reason: unknown) => void
  ): unknown
}

export interface CrashLog {
  error(message: string, detail: unknown): void
}

/** Installs the handlers; returns the uninstaller. */
export function installCrashLogging(proc: ProcessLike, log: CrashLog): () => void {
  const safely = (message: string, reason: unknown): void => {
    try {
      log.error(message, reason)
    } catch {
      // The log itself failed (disk full, file locked): nothing more can be done safely here.
    }
  }
  const onError = (error: unknown): void => safely('main: unhandled error (still running)', error)
  const onRejection = (reason: unknown): void =>
    safely('main: unhandled promise rejection (still running)', reason)

  proc.on('uncaughtException', onError)
  proc.on('unhandledRejection', onRejection)
  return () => {
    proc.removeListener('uncaughtException', onError)
    proc.removeListener('unhandledRejection', onRejection)
  }
}
