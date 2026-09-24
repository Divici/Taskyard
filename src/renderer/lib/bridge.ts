import type { TaskyardApi } from '../../preload/api'

/**
 * `window.taskyard`, read at call time (tests install a fake). Throws when the preload did not
 * run — main logs `preload-error` in that case.
 */
export function getBridge(): TaskyardApi {
  const api = (window as Partial<Window>).taskyard
  if (!api) throw new Error('window.taskyard is missing: the preload did not run')
  return api
}
