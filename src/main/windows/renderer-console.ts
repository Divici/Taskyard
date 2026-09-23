/** The fields of Electron's `console-message` event used for logging. */
export interface ConsoleMessageDetails {
  level: 'info' | 'warning' | 'error' | 'debug'
  message: string
  lineNumber: number
  sourceId: string
}

export interface ConsoleMessageSource {
  on(event: 'console-message', listener: (details: ConsoleMessageDetails) => void): unknown
}

export type RendererConsoleLog = Record<
  'error' | 'warn' | 'verbose' | 'debug',
  (message: string) => void
>

const LEVELS: Record<ConsoleMessageDetails['level'], keyof RendererConsoleLog> = {
  error: 'error',
  warning: 'warn',
  info: 'verbose',
  debug: 'debug'
}

/**
 * Copies a renderer's console output into the main log so renderer errors in the packaged app
 * are not lost; `info` maps to `verbose` so it only appears with TASKYARD_LOG_LEVEL=verbose.
 */
export function forwardRendererConsole(
  source: ConsoleMessageSource,
  log: RendererConsoleLog
): void {
  source.on('console-message', ({ level, message, sourceId, lineNumber }) => {
    log[LEVELS[level]](`renderer: ${message} (${sourceId}:${lineNumber})`)
  })
}
