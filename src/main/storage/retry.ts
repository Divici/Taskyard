/**
 * Windows reports a file briefly held by antivirus, the search indexer or a sync client as one of
 * these; the same call usually succeeds a few hundred milliseconds later.
 */
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE'])

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [50, 150, 400]

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Runs `operation`, retrying transient file-system errors once per entry in `delaysMs`. */
export async function retrying<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const code = errorCode(error)
      if (attempt >= delaysMs.length || !code || !TRANSIENT_CODES.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]))
    }
  }
}
