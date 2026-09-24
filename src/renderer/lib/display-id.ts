/** The query parameter the main process uses to tell a desktop window which display it covers. */
export const DISPLAY_ID_PARAM = 'displayId'

/**
 * The display id from a `location.search` string such as `?displayId=2450156880`, or null when
 * it is missing or not a non-negative safe integer (Electron display ids are integers).
 */
export function parseDisplayId(search: string): number | null {
  const raw = new URLSearchParams(search).get(DISPLAY_ID_PARAM)
  if (raw === null || !/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) ? id : null
}
