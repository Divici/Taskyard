import { user32LoadedMessage } from '../../src/main/win32/load-user32'

export type Flavour = 'packaged' | 'dev'

export type KoffiLogResult =
  | { status: 'pending' }
  | { status: 'ok'; line: string }
  | { status: 'wrong-mode'; line: string }
  | { status: 'failed'; line: string }

const FAILURE_MARKER = 'koffi: user32 load failed'

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '')
}

/** Classifies the main-process log by the koffi startup probe line it contains, if any. */
export function findKoffiResult(logText: string, expected: Flavour = 'packaged'): KoffiLogResult {
  const other: Flavour = expected === 'packaged' ? 'dev' : 'packaged'
  for (const line of lines(logText)) {
    if (line.includes(user32LoadedMessage(expected === 'packaged'))) return { status: 'ok', line }
    if (line.includes(user32LoadedMessage(other === 'packaged'))) {
      return { status: 'wrong-mode', line }
    }
    if (line.includes(FAILURE_MARKER)) return { status: 'failed', line }
  }
  return { status: 'pending' }
}

/** The host's log lines for the shell-menu helper (src/main/shell-menu/host.ts). */
const HELPER_READY_MARKER = 'shell-menu: helper ready'
const HELPER_FAILURE_MARKERS = ['shell-menu: helper failed to start', 'shell-menu: helper exited']

/** Classifies the main-process log by whether the shell-menu helper started, if it reported. */
export function findHelperResult(
  logText: string
): Exclude<KoffiLogResult, { status: 'wrong-mode' }> {
  for (const line of lines(logText)) {
    if (line.includes(HELPER_READY_MARKER)) return { status: 'ok', line }
    if (HELPER_FAILURE_MARKERS.some((marker) => line.includes(marker))) {
      return { status: 'failed', line }
    }
  }
  return { status: 'pending' }
}

export function tailLines(text: string, count: number): string {
  return lines(text).slice(-count).join('\n')
}

/** Calls `check` every `intervalMs` until it returns a value or `timeoutMs` elapses. */
export async function pollUntil<T>(
  check: () => T | undefined,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number }
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
