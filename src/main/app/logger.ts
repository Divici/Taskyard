import { existsSync, renameSync, rmSync } from 'node:fs'
import { join, parse } from 'node:path'
import type { LogFile, LogLevel, NodeLogger } from 'electron-log'

export const LOG_FILE_NAME = 'main.log'
/** main.log is archived once it grows past this size. */
export const LOG_MAX_BYTES = 1024 * 1024
/** Total files kept on disk: main.log plus (LOG_MAX_FILES - 1) numbered archives. */
export const LOG_MAX_FILES = 3

export interface LoggerOptions {
  /** Directory that receives main.log and its archives; created on first write. */
  logDir: string
  level?: LogLevel
  maxBytes?: number
  maxFiles?: number
}

export function defaultLogDir(userDataPath: string): string {
  return join(userDataPath, 'logs')
}

/**
 * Points an electron-log instance (electron-log/main in the app, electron-log/node in tests —
 * both share the same file transport) at `logDir` with size-based rotation.
 */
export function configureLogger<T extends NodeLogger>(logger: T, options: LoggerOptions): T {
  const { logDir, level = 'info', maxBytes = LOG_MAX_BYTES, maxFiles = LOG_MAX_FILES } = options
  const file = logger.transports.file

  file.resolvePathFn = () => join(logDir, LOG_FILE_NAME)
  file.maxSize = maxBytes
  file.level = level
  file.archiveLogFn = (oldLogFile: LogFile) => {
    try {
      rotateLogFiles(oldLogFile.path, maxFiles)
    } catch (error) {
      // A locked archive must not stop logging: start main.log over instead.
      oldLogFile.clear()
      logger.warn('logger: rotation failed, main.log cleared', error)
    }
  }
  logger.transports.console.level = level
  return logger
}

/**
 * Shifts `main.log → main.1.log → main.2.log …`, deleting whatever would exceed `maxFiles`
 * in total. Runs synchronously inside the file transport, before the next line is written.
 */
export function rotateLogFiles(activePath: string, maxFiles: number): void {
  const { dir, name, ext } = parse(activePath)
  const archive = (index: number): string => join(dir, `${name}.${index}${ext}`)
  const oldest = maxFiles - 1

  if (oldest < 1) {
    rmSync(activePath, { force: true })
    return
  }

  rmSync(archive(oldest), { force: true })
  for (let index = oldest - 1; index >= 1; index--) {
    if (existsSync(archive(index))) renameSync(archive(index), archive(index + 1))
  }
  renameSync(activePath, archive(1))
}
