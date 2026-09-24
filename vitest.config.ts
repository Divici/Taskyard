import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/** Real-Win32 tests: opt-in only (npm run test:win32), never part of the headless suite. */
const WIN32_TESTS = '**/*.win32.test.ts'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    // Playwright specs live in e2e/ and are only run by `npm run test:e2e:win`.
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          environment: 'node',
          include: [
            'src/main/**/*.test.ts',
            'src/preload/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'scripts/**/*.test.ts'
          ],
          exclude: [WIN32_TESTS],
          setupFiles: ['src/main/test/setup-headless.ts']
        }
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['src/renderer/test/setupTests.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'win32',
          environment: 'node',
          include: [`src/main/${WIN32_TESTS}`],
          // Real windows and the live z-order: one file at a time, in one process.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } }
        }
      }
    ]
  }
})
