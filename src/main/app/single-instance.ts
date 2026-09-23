/** The slice of Electron's `app` used for the single-instance lock (injectable for tests). */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean
  quit(): void
  on(
    event: 'second-instance',
    listener: (event: unknown, argv: string[], workingDirectory: string) => void
  ): unknown
}

/**
 * Takes the per-userData single-instance lock. The primary instance gets `true` and receives
 * later launches through `onSecondInstance`; a second instance gets `false` and quits — Electron
 * has already delivered its argv to the primary as the `second-instance` event.
 */
export function acquireSingleInstanceLock(
  app: SingleInstanceApp,
  onSecondInstance: (argv: string[], workingDirectory: string) => void
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return false
  }

  app.on('second-instance', (_event, argv, workingDirectory) => {
    onSecondInstance(argv, workingDirectory)
  })
  return true
}
