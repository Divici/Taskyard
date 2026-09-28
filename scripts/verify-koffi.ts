/**
 * npm run verify:koffi — proves koffi's native binary loads inside the packaged app.
 *
 * Launches dist/win-unpacked/Taskyard.exe (from `npm run dist`) with TASKYARD_USER_DATA pointing
 * at a fresh temp profile, waits up to 20 s for the main process to log
 * `koffi: user32 loaded (packaged)`, prints it, then kills the process tree.
 * Exit 0 on success; 1 on timeout, a logged load failure, or an early exit (log tail printed).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ENV } from '../src/main/app/env'
import { defaultSettings } from '../src/shared/defaults'
import { LOG_FILE_NAME } from '../src/main/app/logger'
import { findKoffiResult, pollUntil, tailLines, type KoffiLogResult } from './lib/koffi-log'

const EXE = resolve(__dirname, '../dist/win-unpacked/Taskyard.exe')
const TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 250
const TAIL_LINES = 30

type Outcome =
  Exclude<KoffiLogResult, { status: 'pending' }> | { status: 'exited'; code: number | null }

function describeFailure(outcome: Exclude<Outcome, { status: 'ok' }> | undefined): string {
  if (outcome === undefined) return `no koffi line within ${TIMEOUT_MS / 1000} s`
  if (outcome.status === 'exited') return `Taskyard.exe exited early (code ${outcome.code})`
  return `${outcome.status}: ${outcome.line}`
}

function log(message: string): void {
  console.log(`verify:koffi: ${message}`)
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((done) => {
    const timer = setTimeout(done, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      done()
    })
  })
}

async function main(): Promise<number> {
  if (process.platform !== 'win32') {
    log('Windows only — skipped.')
    return 1
  }
  if (!existsSync(EXE)) {
    log(`${EXE} not found. Run "npm run dist" first.`)
    return 1
  }

  const userData = mkdtempSync(join(tmpdir(), 'taskyard-verify-koffi-'))
  const desktop = join(userData, 'desktop')
  mkdirSync(desktop)
  // Start with Windows off: the packaged app would otherwise register itself in the Run key.
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ ...defaultSettings(), autostart: false })
  )
  const logFile = join(userData, 'logs', LOG_FILE_NAME)
  const readLog = (): string => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')

  log(`launching ${EXE}`)
  log(`${ENV.userData}=${userData}`)
  const child = spawn(EXE, [], {
    // A temp desktop: the packaged app must not scan or watch the real one during the check.
    env: { ...process.env, [ENV.userData]: userData, [ENV.desktopDirs]: desktop },
    stdio: 'ignore'
  })
  let exitCode: number | null | undefined
  child.once('exit', (code) => {
    exitCode = code
  })
  child.once('error', (error) => {
    log(`failed to start: ${error.message}`)
    exitCode = null
  })

  const outcome = await pollUntil<Outcome>(
    () => {
      const result = findKoffiResult(readLog(), 'packaged')
      if (result.status !== 'pending') return result
      if (exitCode !== undefined) return { status: 'exited', code: exitCode }
      return undefined
    },
    { timeoutMs: TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS }
  )

  killTree(child)
  await waitForExit(child, 5_000)

  let status = 1
  if (outcome?.status === 'ok') {
    console.log(outcome.line)
    log('PASS — koffi loaded user32.dll inside the packaged app.')
    status = 0
  } else {
    log(`FAIL — ${describeFailure(outcome)}`)
    const logText = readLog()
    log(logText ? `last ${TAIL_LINES} log lines:` : `no log written at ${logFile}`)
    if (logText) console.log(tailLines(logText, TAIL_LINES))
  }

  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  return status
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
