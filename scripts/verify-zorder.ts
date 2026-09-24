/**
 * npm run verify:zorder — interactive Windows acceptance for the desktop-layer window (Phase 2).
 *
 * Builds the app, launches it with a throwaway TASKYARD_USER_DATA and checks, from outside the
 * process, that every Taskyard window stays seated above the shell desktop window:
 *   1. Notepad (just opened) is above every Taskyard window. When the user already has Notepad
 *      open, a stand-in app window is used instead (a second launch may open a tab in theirs).
 *   2. Every Taskyard window is above the shell window and hides no app window.
 *   3. Win+D right after a burst of 6 Win+D toggles: 800 ms later every Taskyard window is
 *      visible, not minimized, above the shell (the fight back-off must not delay the repair).
 *   4. Win+D again (Explorer restores the windows), then SetForegroundWindow(Taskyard):
 *      Taskyard is foreground yet below Notepad, above the shell, hiding no app window.
 *   5. taskkill + start explorer.exe: within 2 s of the new shell window appearing, every
 *      Taskyard window is visible and seated above the new shell window.
 *   6. Taskbar auto-hide (the brief's manual step, automated): with auto-hide on and Taskyard
 *      foreground, the taskbar stays topmost above Taskyard and slides up when the cursor
 *      reaches the bottom edge. Runs right after check 2: after a synthesized Win+D undo,
 *      Explorer keeps an auto-hide taskbar up even with no Taskyard running (measured), and a
 *      freshly restarted taskbar holds focus and never auto-hides.
 *
 * Side effects, all undone in `finally` and on Ctrl+C: explorer.exe is restarted (always brought
 * back, with the user's own environment), Win+D is pressed twice, taskbar auto-hide is switched
 * on briefly (the original setting is journaled to a temp file first and restored; a run that
 * was killed is healed at the start of the next one), the cursor moves (restored), and one
 * Notepad or stand-in window is opened and closed. Pass --no-build to skip `npm run build`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import koffi from 'koffi'
import type { Hwnd } from '../src/main/win32/api'
import { WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST } from '../src/main/win32/constants'
import { createKoffiWin32Api } from '../src/main/win32/koffi-api'
import {
  createProfile,
  ELECTRON_BINARY,
  MAIN_ENTRY,
  taskyardEnv,
  type Profile
} from '../e2e/helpers/taskyard'
import { appbarJournal, healInterruptedRun } from './lib/appbar-journal'
import { explorerControl } from './lib/explorer'
import { sleepSync } from './lib/sleep-sync'
import { pollUntil } from './lib/koffi-log'
import { ABS_AUTOHIDE, isTaskbarRevealed, withAutoHide } from './lib/taskbar-state'
import { launchStandInApp, STAND_IN_TITLE } from './lib/stand-in-app'
import { loadScriptWin32 } from './lib/win32-script'
import { formatCheck, formatSummary, notRun, type CheckResult } from './lib/zorder-report'

const TITLES = [
  'The app window just opened is above every Taskyard window',
  'Every Taskyard window is above the shell window',
  'Win+D (right after a burst of toggles) leaves Taskyard visible and seated',
  'Foreground Taskyard stays below that app window',
  'Explorer restart: re-seated above the new shell window within 2 s',
  'Auto-hide taskbar still slides up while Taskyard is foreground'
] as const

const WIN_D_SETTLE_MS = 800
const WIN_D_BURST = 6
const WIN_D_BURST_GAP_MS = 400
const EXPLORER_RESEAT_LIMIT_MS = 2_000
const TASKBAR_SLIDE_MS = 1_500
const FOREGROUND_ATTEMPTS = 4

const log = (message: string): void => console.log(`verify:zorder: ${message}`)
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
/** Wall-clock time in the app log's format, to line up with its z-order lines. */
const stamp = (): string =>
  new Date().toTimeString().slice(0, 8) + `.${String(Date.now() % 1000).padStart(3, '0')}`
const hex = (hwnd: Hwnd | null): string => (hwnd === null ? 'null' : `0x${hwnd.toString(16)}`)
const waitFor = <T>(check: () => T | undefined, timeoutMs: number): Promise<T | undefined> =>
  pollUntil(check, { timeoutMs, intervalMs: 50 })

const win32 = loadScriptWin32(koffi)
const api = createKoffiWin32Api(koffi, { log: console })
const explorer = explorerControl(win32, { info: log, warn: log })
const journal = appbarJournal()

/** Undo steps, run newest first, once, from `finally` or a signal handler. */
interface Cleanup {
  name: string
  run: () => void
}
const cleanups: Cleanup[] = []
/** Registers an undo step; the returned function drops that step (by identity) once undone. */
function addCleanup(name: string, run: () => void): () => void {
  const cleanup: Cleanup = { name, run }
  cleanups.push(cleanup)
  return () => {
    const index = cleanups.indexOf(cleanup)
    if (index >= 0) cleanups.splice(index, 1)
  }
}
function runCleanups(): void {
  while (cleanups.length > 0) {
    const { name, run } = cleanups.pop()!
    try {
      run()
    } catch (error) {
      console.error(`verify:zorder: cleanup "${name}" failed`, error)
    }
  }
}
function onSignal(signal: NodeJS.Signals): void {
  log(`${signal} received, undoing side effects`)
  runCleanups()
  process.exit(130)
}

function build(): void {
  log('building (npm run build)')
  const result = spawnSync('npm run build', { shell: true, encoding: 'utf8' })
  if (result.status !== 0) {
    console.log(result.stdout, result.stderr)
    throw new Error(`npm run build failed with exit code ${result.status}`)
  }
}

/** Kills Taskyard's process tree and waits until its main process is gone. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      process.kill(child.pid, 0)
    } catch {
      return
    }
    sleepSync(100)
  }
}

/** Renderer and GPU processes can hold the profile a moment after the main process exits. */
function disposeProfile(profile: Profile): void {
  for (let attempt = 1; ; attempt++) {
    try {
      profile.dispose()
      return
    } catch (error) {
      if (attempt >= 10) throw error
      sleepSync(500)
    }
  }
}

/** Taskyard's visible top-level windows (the Electron main process owns them). */
function taskyardWindows(pid: number): Hwnd[] {
  return win32
    .findWindows('Chrome_WidgetWin_1')
    .filter(
      (h) => win32.processIdOf(h) === pid && win32.isVisible(h) && win32.titleOf(h) === 'Taskyard'
    )
}

const seated = (hwnd: Hwnd, shell: Hwnd | null): boolean =>
  shell !== null && api.isAbove(hwnd, shell)
const allSeated = (windows: Hwnd[]): boolean => {
  const shell = api.getShellWindow()
  return windows.every((hwnd) => seated(hwnd, shell))
}
/** App windows hidden behind Taskyard: visible windows between it and the shell, not ours. */
function coveredBy(windows: Hwnd[]): Hwnd[] {
  const shell = api.getShellWindow()
  if (shell === null) return []
  const ours = new Set(windows)
  const covered = new Set<Hwnd>()
  for (const hwnd of windows) {
    for (const other of api.visibleWindowsBetween(hwnd, shell)) {
      if (!ours.has(other)) covered.add(other)
    }
  }
  return [...covered]
}

/** Taskyard windows ordered by preference: the one on the monitor where `other` sits first. */
function byMonitorOf(windows: Hwnd[], other: Hwnd): Hwnd[] {
  const r = win32.rectOf(other)
  const [x, y] = [(r.left + r.right) / 2, (r.top + r.bottom) / 2]
  const contains = (hwnd: Hwnd): boolean => {
    const w = win32.rectOf(hwnd)
    return x >= w.left && x < w.right && y >= w.top && y < w.bottom
  }
  return [...windows.filter(contains), ...windows.filter((hwnd) => !contains(hwnd))]
}

/**
 * Makes one of `candidates` the foreground window: SetForegroundWindow first (the brief's
 * step), else a real click on an uncovered spot. Returns the window and how, or null.
 */
async function makeForeground(candidates: Hwnd[]): Promise<{ hwnd: Hwnd; how: string } | null> {
  // Windows grants a background process one foreground change per input event; retry.
  for (let attempt = 1; attempt <= FOREGROUND_ATTEMPTS; attempt++) {
    for (const hwnd of candidates) {
      if (win32.setForeground(hwnd)) {
        return { hwnd, how: `SetForegroundWindow${attempt > 1 ? ` (attempt ${attempt})` : ''}` }
      }
    }
    await sleep(250)
  }
  for (const hwnd of candidates) {
    const point = win32.uncoveredPoint(hwnd)
    if (point === null) continue
    win32.clickAt(point.x, point.y)
    await sleep(300)
    if (win32.foregroundWindow() === hwnd) return { hwnd, how: `a click at ${point.x},${point.y}` }
  }
  return null
}

async function checkAutoHideTaskbar(taskyard: Hwnd[]): Promise<CheckResult> {
  const title = TITLES[5]
  const tray = win32.findWindows('Shell_TrayWnd')[0]
  if (tray === undefined) return notRun(title, 'no taskbar window')
  const screen = win32.primaryScreen()
  const [cx, cy] = [Math.round(screen.width / 2), Math.round(screen.height / 2)]
  const primary = taskyard.filter((hwnd) => {
    const r = win32.rectOf(hwnd)
    return cx >= r.left && cx < r.right && cy >= r.top && cy < r.bottom
  })
  if (primary.length === 0) return notRun(title, 'no Taskyard window on the primary monitor')
  const original = win32.appbarState()
  const cursor = win32.cursor()
  const restore = (): void => {
    win32.setAppbarState(original)
    win32.moveCursor(cursor.x, cursor.y)
    if (win32.appbarState() === original) journal.clear()
  }
  // On disk before the taskbar is touched: a killed run is healed by the next one.
  journal.save(original)
  const dropRestore = addCleanup('restore taskbar auto-hide and cursor', restore)
  try {
    win32.setAppbarState(withAutoHide(original))
    const foreground = await makeForeground(primary)
    const revealedNow = (): boolean => isTaskbarRevealed(win32.rectOf(tray), screen.height)
    // Explorer re-evaluates auto-hide when the cursor leaves the taskbar (tool windows such as
    // Taskyard do not count as activations), so run a full edge -> away -> edge cycle.
    win32.moveCursor(cx, screen.height - 1)
    const firstShow = await waitFor(() => (revealedNow() ? true : undefined), TASKBAR_SLIDE_MS)
    win32.moveCursor(cx, cy)
    const hideStarted = Date.now()
    const slidAway = await waitFor(() => (revealedNow() ? undefined : true), TASKBAR_SLIDE_MS * 2)
    const hideMs = Date.now() - hideStarted
    win32.moveCursor(cx, screen.height - 1)
    const showStarted = Date.now()
    const slidUp = await waitFor(() => (revealedNow() ? true : undefined), TASKBAR_SLIDE_MS * 2)
    const showMs = Date.now() - showStarted
    const rect = win32.rectOf(tray)
    // The shell's full-screen heuristic shows up as a taskbar that is no longer topmost.
    const onTop =
      (win32.exStyleOf(tray) & WS_EX_TOPMOST) !== 0 &&
      primary.every((hwnd) => api.isAbove(tray, hwnd))
    const now = win32.foregroundWindow()
    const stillForeground = foreground !== null && now === foreground.hwnd
    const how = foreground
      ? `${hex(foreground.hwnd)} made foreground by ${foreground.how}` +
        (stillForeground
          ? ''
          : ` (then lost it to ${now === null ? 'nothing' : win32.classOf(now)})`)
      : 'NOT made foreground'
    return {
      title,
      pass: stillForeground && slidAway === true && slidUp === true && onTop,
      detail:
        `auto-hide was ${original & ABS_AUTOHIDE ? 'on' : 'off'} (restored after); Taskyard ${how}; ` +
        `shown at the edge: ${firstShow === true}; ` +
        `slid away ${slidAway ? `${hideMs} ms` : 'NOT'} after the cursor left; ` +
        `slid up ${slidUp ? `${showMs} ms` : 'NOT'} after it came back (y=${rect.top}..${rect.bottom}); ` +
        `taskbar topmost above Taskyard: ${onTop}`
    }
  } finally {
    dropRestore()
    restore()
  }
}

/** Opens the "other app" for checks 1, 3 and 4: Notepad, or a stand-in if Notepad is open. */
async function openOtherApp(dir: string): Promise<{ hwnd: Hwnd; name: string }> {
  const existing = win32.findWindows('Notepad')
  if (existing.length === 0) {
    spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref()
    const notepad = await waitFor(
      () => win32.findWindows('Notepad').find((h) => win32.isVisible(h)),
      15_000
    )
    if (notepad === undefined) throw new Error('Notepad did not open a window within 15 s')
    addCleanup('close Notepad', () => win32.postClose(notepad))
    return activated({ hwnd: notepad, name: 'Notepad' })
  }

  log(`Notepad is already open (${existing.length} window(s)); using a stand-in app window`)
  const child = launchStandInApp(ELECTRON_BINARY, join(dir, 'stand-in'), cleanEnv())
  addCleanup('close the stand-in app', () => killTree(child))
  const standIn = await waitFor(
    () =>
      win32
        .findWindows('Chrome_WidgetWin_1')
        .find(
          (h) =>
            win32.processIdOf(h) === child.pid &&
            win32.isVisible(h) &&
            win32.titleOf(h) === STAND_IN_TITLE
        ),
    20_000
  )
  if (standIn === undefined) throw new Error('the stand-in app window did not appear in 20 s')
  return activated({ hwnd: standIn, name: 'stand-in app' })
}

/**
 * A window launched from this background process cannot take the foreground, so Windows
 * flashes its taskbar button instead, and a flashing button keeps an auto-hide taskbar up.
 * Activating it (as a user who just opened an app would be) ends the flash.
 */
function activated(app: { hwnd: Hwnd; name: string }): { hwnd: Hwnd; name: string } {
  if (!win32.setForeground(app.hwnd)) log(`could not activate the ${app.name} window`)
  return app
}

/** This process's environment minus variables that would change how Electron starts. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  return env
}

async function checkExplorerRestart(taskyard: Hwnd[]): Promise<CheckResult> {
  const title = TITLES[4]
  const oldShell = api.getShellWindow()
  addCleanup('make sure Explorer runs', () => void explorer.ensureRunning())
  log(`restarting explorer.exe at ${stamp()}`)
  explorer.kill()
  await waitFor(() => (explorer.isShellUp() ? undefined : true), 10_000)
  const startedAt = Date.now()
  explorer.start()
  const newShell = await waitFor(() => {
    const current = api.getShellWindow()
    return current !== null && current !== oldShell ? current : undefined
  }, 30_000)
  if (newShell === undefined) return { title, pass: false, detail: 'no new shell window in 30 s' }

  const appearedAt = Date.now()
  const reseated = await waitFor(
    () => (allSeated(taskyard) ? true : undefined),
    EXPLORER_RESEAT_LIMIT_MS
  )
  const reseatMs = Date.now() - appearedAt
  await sleep(Math.max(0, EXPLORER_RESEAT_LIMIT_MS - reseatMs))
  const current = api.getShellWindow()
  const visible = taskyard.filter((h) => win32.isVisible(h) && !win32.isIconic(h))
  const seatedNow = taskyard.filter((h) => seated(h, current))
  return {
    title,
    pass:
      reseated === true &&
      current !== oldShell &&
      visible.length === taskyard.length &&
      seatedNow.length === taskyard.length,
    detail:
      `old shell ${hex(oldShell)}, new ${hex(current)} (${current === null ? '-' : win32.classOf(current)}) ` +
      `${appearedAt - startedAt} ms after explorer.exe started; ` +
      `seated ${reseated ? `${reseatMs} ms` : 'NOT within 2 s'} after it appeared; ` +
      `at +${EXPLORER_RESEAT_LIMIT_MS} ms visible ${visible.length}/${taskyard.length}, ` +
      `seated ${seatedNow.length}/${taskyard.length}`
  }
}

async function run(results: (CheckResult | undefined)[]): Promise<void> {
  const profile = createProfile()
  addCleanup('delete the temp profile', () => disposeProfile(profile))
  log(`launching ${MAIN_ENTRY} with TASKYARD_USER_DATA=${profile.userData}`)
  const child = spawn(ELECTRON_BINARY, [MAIN_ENTRY], { env: taskyardEnv(profile), stdio: 'ignore' })
  addCleanup('close Taskyard', () => killTree(child))
  if (child.pid === undefined) throw new Error('Taskyard did not start')
  const pid = child.pid

  const monitors = win32.monitorCount()
  const taskyard = await waitFor(() => {
    const windows = taskyardWindows(pid)
    return windows.length === monitors && allSeated(windows) ? windows : undefined
  }, 20_000)
  if (taskyard === undefined) {
    throw new Error(`Taskyard did not show ${monitors} seated windows within 20 s`)
  }
  const shell = api.getShellWindow()
  const styles = taskyard.map((hwnd) => win32.exStyleOf(hwnd))
  const rects = taskyard.map((hwnd) => {
    const r = win32.rectOf(hwnd)
    return `${hex(hwnd)} [${r.left},${r.top} ${r.right - r.left}x${r.bottom - r.top}]`
  })
  log(`Taskyard windows ${rects.join(', ')} on ${monitors} monitor(s)`)
  log(
    `WS_EX_TOOLWINDOW (no taskbar button, no Alt-Tab): ${styles.every((s) => s & WS_EX_TOOLWINDOW) ? 'set' : 'MISSING'}; ` +
      `WS_EX_APPWINDOW: ${styles.some((s) => s & WS_EX_APPWINDOW) ? 'SET' : 'clear'} ` +
      `(ex styles ${styles.map((s) => `0x${(s >>> 0).toString(16)}`).join(', ')})`
  )
  log(`shell window ${hex(shell)} (${shell === null ? '-' : win32.classOf(shell)})`)

  // 1-2. The other app on top; Taskyard directly on the shell window.
  const other = await openOtherApp(profile.userData)
  const notepad = other.hwnd
  await sleep(500)

  const aboveTaskyard = taskyard.filter((hwnd) => api.isAbove(notepad, hwnd))
  results[0] = {
    title: TITLES[0],
    pass: aboveTaskyard.length === taskyard.length,
    detail: `${other.name} ${hex(notepad)} above ${aboveTaskyard.length}/${taskyard.length} Taskyard window(s)`
  }
  const seatedAtStart = taskyard.filter((hwnd) => seated(hwnd, api.getShellWindow()))
  const coveredAtStart = coveredBy(taskyard)
  results[1] = {
    title: TITLES[1],
    pass: seatedAtStart.length === taskyard.length && coveredAtStart.length === 0,
    detail:
      `${seatedAtStart.length}/${taskyard.length} above ${hex(api.getShellWindow())}; ` +
      `app windows hidden behind Taskyard: ${coveredAtStart.length}`
  }

  // 6 runs here, before Win+D and the Explorer restart (see the header).
  results[5] = await checkAutoHideTaskbar(taskyard)

  // 3. A burst of Win+D toggles (an even count: back where it started), then the measured one.
  log(`pressing Win+D ${WIN_D_BURST} times in a burst at ${stamp()}`)
  for (let press = 0; press < WIN_D_BURST; press++) {
    win32.pressWinD()
    await sleep(WIN_D_BURST_GAP_MS)
  }
  if (win32.isIconic(notepad)) win32.pressWinD() // a press that did not register: even it out
  await sleep(WIN_D_BURST_GAP_MS)
  log(`pressing Win+D at ${stamp()}`)
  win32.pressWinD()
  // Press again on the way out only while the desktop is still shown (the app still minimized).
  const dropUndo = addCleanup('undo Win+D', () => {
    if (win32.isIconic(notepad)) win32.pressWinD()
  })
  await sleep(WIN_D_SETTLE_MS)
  const minimizedNotepad = win32.isIconic(notepad)
  const shown = taskyard.filter((h) => win32.isVisible(h) && !win32.isIconic(h))
  const seatedAfterWinD = taskyard.filter((h) => seated(h, api.getShellWindow()))
  results[2] = {
    title: TITLES[2],
    pass:
      minimizedNotepad &&
      shown.length === taskyard.length &&
      seatedAfterWinD.length === taskyard.length,
    detail:
      `after ${WIN_D_BURST} toggles, Win+D minimized ${other.name}: ${minimizedNotepad}; visible and not minimized: ${shown.length}/${taskyard.length}; ` +
      `above the shell: ${seatedAfterWinD.length}/${taskyard.length} after ${WIN_D_SETTLE_MS} ms`
  }

  // 4. Win+D again (Explorer restores the windows), then Taskyard foreground. The second press
  // is skipped when the first had no effect: it would itself show the desktop.
  dropUndo()
  if (minimizedNotepad) {
    log(`pressing Win+D again at ${stamp()}`)
    win32.pressWinD()
    await sleep(WIN_D_SETTLE_MS)
  } else {
    log('Win+D did not minimize the app window; not pressing it again')
  }
  const foreground = await makeForeground(byMonitorOf(taskyard, notepad))
  await sleep(300)
  const isForeground = foreground !== null && win32.foregroundWindow() === foreground.hwnd
  const belowNotepad = taskyard.filter((hwnd) => api.isAbove(notepad, hwnd))
  const stillSeated = taskyard.filter((hwnd) => seated(hwnd, api.getShellWindow()))
  const covered = coveredBy(taskyard)
  results[3] = {
    title: TITLES[3],
    pass:
      isForeground &&
      belowNotepad.length === taskyard.length &&
      stillSeated.length === taskyard.length &&
      covered.length === 0,
    detail:
      `${other.name} restored: ${!win32.isIconic(notepad)}; ` +
      `Taskyard ${foreground ? `${hex(foreground.hwnd)} made foreground by ${foreground.how}` : 'NOT foreground'}; ` +
      `below ${other.name}: ${belowNotepad.length}/${taskyard.length}; above the shell: ${stillSeated.length}/${taskyard.length}; ` +
      `app windows hidden behind Taskyard: ${covered.length}`
  }

  // 5. Explorer restart, last: it is the most disruptive step.
  results[4] = await checkExplorerRestart(taskyard)
  if (!explorer.ensureRunning()) throw new Error('explorer.exe did not come back')

  const sentinel = profile
    .readLog()
    .split(/\r?\n/)
    .filter((line) => line.includes('zorder:'))
  log(`app log, z-order sentinel lines (${sentinel.length}):`)
  for (const line of sentinel) console.log(`  ${line}`)
}

async function main(): Promise<number> {
  if (process.platform !== 'win32') {
    log('Windows only, skipped.')
    return 1
  }
  win32.makeDpiAware()
  // Undo whatever a killed earlier run left behind before touching anything.
  const healed = healInterruptedRun(journal, (state) => win32.setAppbarState(state))
  if (healed !== null) log(`restored taskbar appbar state ${healed} left by an interrupted run`)
  if (!explorer.isShellUp()) {
    log('explorer.exe is not running (an interrupted run?); starting it')
    if (!explorer.ensureRunning()) throw new Error('explorer.exe could not be started')
  }
  if (!process.argv.includes('--no-build')) build()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, onSignal)

  const partial: (CheckResult | undefined)[] = []
  try {
    await run(partial)
  } catch (error) {
    log(`stopped early: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    runCleanups()
    if (!explorer.ensureRunning()) {
      log('WARNING: explorer.exe is not running; start it from Task Manager')
    }
  }

  const results = TITLES.map(
    (title, index) => partial[index] ?? notRun(title, 'an earlier step failed')
  )
  console.log('')
  results.forEach((result, index) => console.log(formatCheck(index + 1, result)))
  const summary = formatSummary(results, TITLES.length)
  console.log(summary)
  return summary.includes(': PASS') ? 0 : 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  }
)
