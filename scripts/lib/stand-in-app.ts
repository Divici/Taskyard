import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Title of the stand-in app window `verify:zorder` opens when Notepad is already in use. */
export const STAND_IN_TITLE = 'verify-zorder stand-in'

const MAIN_SCRIPT = `
const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 900, height: 600, title: '${STAND_IN_TITLE}', autoHideMenuBar: true })
  window.loadURL('data:text/html,<title>${STAND_IN_TITLE}</title><h1>verify:zorder stand-in</h1>')
})
app.on('window-all-closed', () => app.quit())
`

/**
 * An ordinary, activatable app window in its own Electron process. Used instead of Notepad when
 * the user already has Notepad open: a second launch may open a tab in the user's window.
 */
export function launchStandInApp(
  electronBinary: string,
  dir: string,
  env: NodeJS.ProcessEnv
): ChildProcess {
  mkdirSync(dir, { recursive: true })
  const main = join(dir, 'stand-in.cjs')
  writeFileSync(main, MAIN_SCRIPT)
  return spawn(electronBinary, [main, `--user-data-dir=${join(dir, 'user-data')}`], {
    env,
    stdio: 'ignore'
  })
}
