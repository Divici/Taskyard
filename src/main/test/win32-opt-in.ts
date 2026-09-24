/**
 * Real-Win32 tests (`*.win32.test.ts`) create real windows, move the live z-order and need
 * Explorer, so they never run in `npm test`. They run only through `npm run test:win32`, which
 * sets TASKYARD_WIN32_TESTS=1, and never under TASKYARD_NO_WIN32=1.
 */
export const WIN32_TESTS_ENV = 'TASKYARD_WIN32_TESTS'

export function realWin32TestsEnabled(
  env: Partial<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && env[WIN32_TESTS_ENV] === '1' && env['TASKYARD_NO_WIN32'] !== '1'
}
