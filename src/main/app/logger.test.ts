import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodeLogger } from 'electron-log'
import nodeLog from 'electron-log/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  configureLogger,
  defaultLogDir,
  LOG_FILE_NAME,
  LOG_MAX_BYTES,
  LOG_MAX_FILES,
  rotateLogFiles,
  type LoggerOptions
} from './logger'

const LINE_PAYLOAD = 'x'.repeat(1000)

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'taskyard-logger-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** A fresh electron-log instance (same file transport as electron-log/main) with console muted. */
function createTestLogger(options: Omit<LoggerOptions, 'logDir'> = {}): {
  logger: NodeLogger
  logDir: string
  logFile: string
} {
  const logDir = join(tmp, 'logs')
  const logger = configureLogger(nodeLog.create({ logId: `test-${randomUUID()}` }), {
    logDir,
    ...options
  })
  logger.transports.console.level = false
  return { logger, logDir, logFile: join(logDir, LOG_FILE_NAME) }
}

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

describe('logger', () => {
  it('uses a 1 MB rotation threshold and keeps 3 files by default', () => {
    const { logger } = createTestLogger()

    expect(LOG_MAX_BYTES).toBe(1024 * 1024)
    expect(LOG_MAX_FILES).toBe(3)
    expect(logger.transports.file.maxSize).toBe(LOG_MAX_BYTES)
  })

  it('defaults the log directory to <userData>/logs', () => {
    const userData = join(tmp, 'Taskyard')
    expect(defaultLogDir(userData)).toBe(join(userData, 'logs'))
  })

  it('writes log lines to main.log inside the injected directory (created on demand)', () => {
    const { logger, logDir, logFile } = createTestLogger()

    logger.info('hello from the logger test')

    expect(readdirSync(logDir)).toEqual([LOG_FILE_NAME])
    expect(readFileSync(logFile, 'utf8')).toMatch(/\[info\]\s+hello from the logger test/)
  })

  it('applies the configured level to the file transport', () => {
    const { logger, logFile } = createTestLogger({ level: 'warn' })

    logger.info('suppressed info line')
    logger.warn('visible warn line')

    const content = readFileSync(logFile, 'utf8')
    expect(content).not.toContain('suppressed info line')
    expect(content).toContain('visible warn line')
  })

  it('does not rotate while main.log is at or below 1 MB', () => {
    const { logger, logDir, logFile } = createTestLogger()

    while (sizeOf(logFile) + LINE_PAYLOAD.length * 2 < LOG_MAX_BYTES) logger.info(LINE_PAYLOAD)

    expect(readdirSync(logDir)).toEqual([LOG_FILE_NAME])
  })

  it('rotates main.log to main.1.log once it exceeds 1 MB', () => {
    const { logger, logDir, logFile } = createTestLogger()

    while (sizeOf(logFile) <= LOG_MAX_BYTES) logger.info(LINE_PAYLOAD)
    const sizeBeforeRotation = sizeOf(logFile)
    logger.info('first line after rotation')

    const archive = join(logDir, 'main.1.log')
    expect(readdirSync(logDir).sort()).toEqual(['main.1.log', LOG_FILE_NAME].sort())
    expect(sizeOf(archive)).toBe(sizeBeforeRotation)
    expect(sizeOf(archive)).toBeGreaterThan(LOG_MAX_BYTES)
    expect(readFileSync(archive, 'utf8')).not.toContain('first line after rotation')
    expect(readFileSync(logFile, 'utf8')).toContain('first line after rotation')
    expect(sizeOf(logFile)).toBeLessThan(LOG_MAX_BYTES)
  })

  it('keeps logging and clears main.log when rotation fails', () => {
    const { logger, logDir, logFile } = createTestLogger({ maxBytes: 4 * 1024 })
    // A directory where the oldest archive should go makes the rotation throw.
    mkdirSync(join(logDir, 'main.2.log', 'blocker'), { recursive: true })

    for (let i = 0; i < 6; i++) logger.info(`before ${i} ${LINE_PAYLOAD}`)
    logger.info('after the failed rotation')

    const content = readFileSync(logFile, 'utf8')
    expect(content).toContain('logger: rotation failed, main.log cleared')
    expect(content).toContain('after the failed rotation')
    expect(content).not.toContain('before 0 ')
    expect(existsSync(join(logDir, 'main.1.log'))).toBe(false)
  })

  it('never keeps more than 3 files across repeated rotations', () => {
    const { logger, logDir } = createTestLogger({ maxBytes: 4 * 1024 })

    for (let i = 0; i < 200; i++) logger.info(`line ${i} ${LINE_PAYLOAD}`)

    expect(readdirSync(logDir).sort()).toEqual(['main.1.log', 'main.2.log', LOG_FILE_NAME].sort())
    expect(readFileSync(join(logDir, LOG_FILE_NAME), 'utf8')).toContain('line 199 ')
  })
})

describe('rotateLogFiles', () => {
  it('shifts archives up by one and drops the oldest beyond maxFiles', () => {
    const active = join(tmp, LOG_FILE_NAME)
    writeFileSync(active, 'current')
    writeFileSync(join(tmp, 'main.1.log'), 'previous')
    writeFileSync(join(tmp, 'main.2.log'), 'oldest')

    rotateLogFiles(active, 3)

    expect(existsSync(active)).toBe(false)
    expect(readFileSync(join(tmp, 'main.1.log'), 'utf8')).toBe('current')
    expect(readFileSync(join(tmp, 'main.2.log'), 'utf8')).toBe('previous')
    expect(existsSync(join(tmp, 'main.3.log'))).toBe(false)
  })

  it('works when no archives exist yet', () => {
    const active = join(tmp, LOG_FILE_NAME)
    writeFileSync(active, 'current')

    rotateLogFiles(active, 3)

    expect(readdirSync(tmp)).toEqual(['main.1.log'])
  })
})
