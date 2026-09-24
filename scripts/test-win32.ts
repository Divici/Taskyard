/**
 * npm run test:win32 — the opt-in real-Win32 suite (`src/main/**\/*.win32.test.ts`). It creates
 * real windows and moves the live z-order, so it needs an interactive Windows desktop and is
 * never part of `npm test`. Refuses to run under TASKYARD_NO_WIN32=1.
 */
import { spawnSync } from 'node:child_process'
import { WIN32_TESTS_ENV } from '../src/main/test/win32-opt-in'

function main(): number {
  if (process.platform !== 'win32') {
    console.error('test:win32: Windows only.')
    return 1
  }
  if (process.env['TASKYARD_NO_WIN32'] === '1') {
    console.error('test:win32: TASKYARD_NO_WIN32=1 is set, so the real-Win32 suite does not run.')
    return 1
  }
  const result = spawnSync('npx vitest run --project win32', {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, [WIN32_TESTS_ENV]: '1' }
  })
  return result.status ?? 1
}

process.exitCode = main()
