import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { forwardRendererConsole, type ConsoleMessageDetails } from './renderer-console'

function setup(): {
  emit(details: Omit<ConsoleMessageDetails, 'lineNumber' | 'sourceId'>): void
  log: Record<'error' | 'warn' | 'verbose' | 'debug', ReturnType<typeof vi.fn>>
} {
  const source = new EventEmitter()
  const log = { error: vi.fn(), warn: vi.fn(), verbose: vi.fn(), debug: vi.fn() }
  forwardRendererConsole(source, log)
  return {
    emit: (details) =>
      source.emit('console-message', { ...details, lineNumber: 12, sourceId: 'app://main.tsx' }),
    log
  }
}

describe('forwardRendererConsole', () => {
  it('logs renderer errors with their source location', () => {
    const { emit, log } = setup()

    emit({ level: 'error', message: 'Uncaught TypeError: boom' })

    expect(log.error).toHaveBeenCalledExactlyOnceWith(
      'renderer: Uncaught TypeError: boom (app://main.tsx:12)'
    )
  })

  it('maps warning, info and debug to warn, verbose and debug', () => {
    const { emit, log } = setup()

    emit({ level: 'warning', message: 'CSP blocked an inline script' })
    emit({ level: 'info', message: 'hello' })
    emit({ level: 'debug', message: 'details' })

    expect(log.warn).toHaveBeenCalledExactlyOnceWith(
      'renderer: CSP blocked an inline script (app://main.tsx:12)'
    )
    expect(log.verbose).toHaveBeenCalledExactlyOnceWith('renderer: hello (app://main.tsx:12)')
    expect(log.debug).toHaveBeenCalledExactlyOnceWith('renderer: details (app://main.tsx:12)')
    expect(log.error).not.toHaveBeenCalled()
  })
})
