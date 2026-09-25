import { spawn } from 'node:child_process'
import { expect, test } from '@playwright/test'
import {
  createProfile,
  ELECTRON_BINARY,
  launchTaskyard,
  MAIN_ENTRY,
  taskyardEnv
} from './helpers/taskyard'

test('a second launch exits after signalling the running instance', async () => {
  const profile = createProfile()
  const first = await launchTaskyard(profile)
  try {
    await first.firstWindow()
    await expect.poll(() => profile.readLog()).toContain('koffi: user32 loaded (dev)')

    const second = spawn(ELECTRON_BINARY, [MAIN_ENTRY], {
      env: taskyardEnv(profile),
      stdio: 'ignore'
    })
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        second.kill()
        reject(new Error('second instance did not exit within 15 s'))
      }, 15_000)
      second.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })

    expect(exitCode).toBe(0)
    await expect.poll(() => profile.readLog()).toContain('app: second-instance received')
    // Phase 9: the running instance answers with a Peek (the user is looking for Taskyard).
    await expect.poll(() => profile.readLog()).toContain('peek: on')
    const page = await first.firstWindow()
    await expect(page.getByRole('main')).toHaveAttribute('data-peeking', 'true')
    // Only the primary ever initialised the logger and opened windows (one per display).
    expect(profile.readLog().match(/app: starting Taskyard/g)).toHaveLength(1)
    const displayCount = await first.evaluate(({ screen }) => screen.getAllDisplays().length)
    await expect.poll(() => first.windows().length).toBe(displayCount)
  } finally {
    await first.close()
    profile.dispose()
  }
})
