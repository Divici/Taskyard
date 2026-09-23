import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

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
          ]
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
      }
    ]
  }
})
