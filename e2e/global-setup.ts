import { spawnSync } from 'node:child_process'

/** Builds main, preload and renderer into out/ so every e2e run exercises the current sources. */
export default function globalSetup(): void {
  const result = spawnSync('npm run build', { stdio: 'inherit', shell: true })
  if (result.status !== 0) {
    throw new Error(`electron-vite build failed with exit code ${result.status}`)
  }
}
