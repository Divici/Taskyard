import { defineConfig } from '@playwright/test'

// Interactive Windows runs only: each spec launches the built Electron app (out/main/index.js)
// with an isolated TASKYARD_USER_DATA profile, so specs run serially against a fresh build.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: './test-results'
})
