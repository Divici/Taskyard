export type Env = Partial<Record<string, string | undefined>>

/**
 * Expands `%NAME%` the way Windows does: names are case-insensitive, and an unknown name is left
 * as written (`%NoSuchVar%`).
 */
export function expandEnvVars(text: string, env: Env): string {
  if (!text.includes('%')) return text
  const byUpper = new Map<string, string>()
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) byUpper.set(key.toUpperCase(), value)
  }
  return text.replace(
    /%([^%]+)%/g,
    (match, name: string) => byUpper.get(name.toUpperCase()) ?? match
  )
}
