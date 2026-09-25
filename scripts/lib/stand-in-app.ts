import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Title of the stand-in app window `verify:zorder` opens when Notepad is already in use. */
export const STAND_IN_TITLE = 'verify-zorder stand-in'

export interface StandInOptions {
  /** Window title (and page title); `STAND_IN_TITLE` by default. */
  title?: string
  /** Maximized on the primary display (Peek e2e: "a maximized app window"). */
  maximize?: boolean
}

function mainScript({ title = STAND_IN_TITLE, maximize = false }: StandInOptions): string {
  return `
const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 900, height: 600, title: ${JSON.stringify(title)}, autoHideMenuBar: true, show: false })
  window.once('ready-to-show', () => {
    ${maximize ? 'window.maximize()' : ''}
    window.show()
  })
  window.loadURL('data:text/html,<title>' + encodeURIComponent(${JSON.stringify(title)}) + '</title><h1>stand-in</h1>')
})
app.on('window-all-closed', () => app.quit())
`
}

/**
 * An ordinary, activatable app window in its own Electron process. Used instead of Notepad when
 * the user already has Notepad open: a second launch may open a tab in the user's window.
 */
export function launchStandInApp(
  electronBinary: string,
  dir: string,
  env: NodeJS.ProcessEnv,
  options: StandInOptions = {}
): ChildProcess {
  mkdirSync(dir, { recursive: true })
  const main = join(dir, 'stand-in.cjs')
  writeFileSync(main, mainScript(options))
  return spawn(electronBinary, [main, `--user-data-dir=${join(dir, 'user-data')}`], {
    env,
    stdio: 'ignore'
  })
}
