import { vi } from 'vitest'

/**
 * The `main` project is the headless suite (npm test; hosted CI). Any attempt to use the real
 * koffi module here fails loudly: Win32 behaviour is tested through the fake, and real-Win32
 * tests live in `*.win32.test.ts` (npm run test:win32).
 */
vi.mock('koffi', () => {
  const refuse = (): never => {
    throw new Error('the headless unit suite must not call real Win32 (koffi); use the fake')
  }
  return { default: new Proxy({}, { get: refuse }), load: refuse }
})
