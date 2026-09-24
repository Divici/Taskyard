import type { z } from 'zod'

export type ExactParseResult<T> = { success: true; data: T } | { success: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function join(path: string, key: string | number): string {
  return path === '' ? String(key) : `${path}.${key}`
}

/**
 * The first place where `parsed` is not exactly `input`: a key the schema added (a default
 * filled a missing field) or a key it stripped (unknown to the schema). null when identical.
 */
function firstDifference(input: unknown, parsed: unknown, path = ''): string | null {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    for (let index = 0; index < parsed.length; index++) {
      const found = firstDifference(input[index], parsed[index], join(path, index))
      if (found) return found
    }
    return null
  }
  if (isRecord(input) && isRecord(parsed)) {
    for (const key of Object.keys(parsed)) {
      if (!(key in input))
        return `${join(path, key)}: missing (the file would silently take a default)`
      const found = firstDifference(input[key], parsed[key], join(path, key))
      if (found) return found
    }
    for (const key of Object.keys(input)) {
      if (!(key in parsed)) return `${join(path, key)}: unknown key`
    }
    return null
  }
  return Object.is(input, parsed) ? null : `${path || 'value'}: changed while parsing`
}

/**
 * Validates data coming in over IPC against a load-time schema, but strictly: every field at
 * every depth must be present (no defaults may be applied) and no unknown key may appear.
 * The load schemas keep their defaults so older files still load; a *save* that relies on them
 * would silently replace, for example, a display missing `tools` with the default widget, or a
 * whole layout with an empty one.
 */
export function parseExact<T>(schema: z.ZodType<T>, input: unknown): ExactParseResult<T> {
  const result = schema.safeParse(input)
  if (!result.success) {
    const error = result.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || 'value'}: ${issue.message}`)
      .join('; ')
    return { success: false, error }
  }
  const difference = firstDifference(input, result.data)
  return difference ? { success: false, error: difference } : { success: true, data: result.data }
}
