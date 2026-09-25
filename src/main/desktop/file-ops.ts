import { constants } from 'node:fs'
import { copyFile, cp, lstat, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, win32 } from 'node:path'
import type {
  DesktopActionResult,
  DesktopErrorCode,
  DesktopFailure,
  MoveOutcome,
  MoveToDesktopResult,
  RenameResult,
  UndoMoveResult
} from '@shared/ipc'
import type { MoveOp } from '@shared/schema'
import { fileIdOf, hashPath } from '../storage/file-hash'
import { partialPathFor, type OpsJournal } from '../storage/ops-journal'
import type { Win32Api } from '../win32/api'
import { freeName, isVolumeOrShareRoot, validateFileName } from './file-names'
import { pathKey, type DesktopModel } from './model'
import type { DesktopTracker } from './watcher'

/** The Electron `shell` calls the file operations use. */
export interface FileOpsShell {
  /** Resolves to '' on success, else Windows' error text. */
  openPath(path: string): Promise<string>
  openExternal(url: string): Promise<void>
  showItemInFolder(path: string): void
  trashItem(path: string): Promise<void>
}

export interface FileOpsDeps {
  model: Pick<DesktopModel, 'get' | 'idAt'>
  tracker: Pick<DesktopTracker, 'applyRenamed' | 'applyRemoved' | 'applyPresent'>
  /** The desktop folders as last scanned; the first is the user Desktop (moves land there). */
  folders: () => ReadonlyArray<{ path: string; readonly: boolean }>
  win32: Pick<Win32Api, 'moveFile' | 'setHidden'>
  shell: FileOpsShell
  journal: Pick<OpsJournal, 'begin' | 'advance' | 'get'>
  log: { info(message: string): void; warn(message: string, ...details: unknown[]): void }
  /** SHA-256 of a file or folder tree (injectable to test a mismatch). */
  hash?: (path: string) => Promise<string>
  /** Whether `path` and `dir` are on one volume (injectable to test the copy path). */
  sameVolume?: (path: string, dir: string) => Promise<boolean>
  /** Deletes a moved source after its verified copy is in place (injectable to test a lock). */
  removeSource?: (path: string) => Promise<void>
}

export interface FileOps {
  open(id: string): Promise<DesktopActionResult>
  showInFolder(id: string): Promise<DesktopActionResult>
  rename(id: string, newName: string): Promise<RenameResult>
  trash(id: string): Promise<DesktopActionResult>
  moveToDesktop(paths: readonly string[]): Promise<MoveToDesktopResult>
  undoMove(token: string): Promise<UndoMoveResult>
}

const ERROR_CODES: Readonly<Record<string, DesktopErrorCode>> = {
  EEXIST: 'exists',
  ENOTEMPTY: 'exists',
  EPERM: 'permission',
  EACCES: 'permission',
  EBUSY: 'busy',
  ENAMETOOLONG: 'name-too-long',
  EINVAL: 'invalid-name',
  ENOENT: 'not-found'
}

function failure(code: DesktopErrorCode, message: string): DesktopFailure {
  return { ok: false, code, message }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A thrown file-system error as a typed failure (EEXIST → exists, EPERM → permission…). */
export function failureFrom(error: unknown): DesktopFailure {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if ((error as Error | null)?.name === 'JournalReadOnlyError') {
    return failure('journal-read-only', messageOf(error))
  }
  return failure((code && ERROR_CODES[code]) || 'failed', messageOf(error))
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function onSameVolume(path: string, dir: string): Promise<boolean> {
  const [a, b] = await Promise.all([stat(path, { bigint: true }), stat(dir, { bigint: true })])
  return a.dev === b.dev
}

/**
 * Open / show / rename / trash for desktop items, and Explorer drops moved onto the desktop.
 * Nothing here ever replaces a file: renames and moves use `MoveFileExW` without
 * `MOVEFILE_REPLACE_EXISTING`, and a colliding drop gets a Windows-style `name (2).ext`. Every
 * failure is a typed result (`DesktopFailure`), never a throw across IPC. Items in a read-only
 * folder are refused before the disk is touched.
 */
export function createFileOps(deps: FileOpsDeps): FileOps {
  const hash = deps.hash ?? ((path: string) => hashPath(path))
  const sameVolume = deps.sameVolume ?? onSameVolume
  const removeSource = deps.removeSource ?? ((path: string) => rm(path, { recursive: true }))
  const notFound = (id: string): DesktopFailure =>
    failure('not-found', `${id} is not on the desktop`)

  /**
   * Moves `from` to `to` for a journaled op. Same volume: one atomic rename (`done`). Otherwise
   * (or when Windows says EXDEV): copy to the op's hidden `.taskyard-<token>.partial` next to
   * `to`, compare SHA-256, journal `copied` with the copy's file id, rename into `to`, delete
   * the source, `done`. A mismatch deletes the copy and keeps the source (`undone`).
   */
  async function transfer(op: MoveOp, isDirectory: boolean): Promise<DesktopFailure | null> {
    const { from, to, token } = op
    if (await sameVolume(from, dirname(to))) {
      try {
        deps.win32.moveFile(from, to)
        deps.journal.advance(token, 'done')
        return null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
          deps.journal.advance(token, 'undone')
          return failureFrom(error)
        }
      }
    }

    const partial = partialPathFor(op)
    try {
      if (isDirectory) {
        await cp(from, partial, {
          recursive: true,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true
        })
      } else {
        await copyFile(from, partial, constants.COPYFILE_EXCL)
      }
      deps.win32.setHidden(partial, true)
      const [source, copy] = await Promise.all([hash(from), hash(partial)])
      if (source !== copy) {
        await rm(partial, { recursive: true, force: true })
        deps.journal.advance(token, 'undone')
        deps.log.warn(`desktop: copy of ${from} did not match its source; the source is kept`)
        return failure('hash-mismatch', `the copy of ${from} did not match; nothing was moved`)
      }
      deps.journal.advance(token, 'copied', { toId: await fileIdOf(partial) })
      deps.win32.setHidden(partial, false)
      deps.win32.moveFile(partial, to)
    } catch (error) {
      await rm(partial, { recursive: true, force: true }).catch(() => {})
      deps.journal.advance(token, 'undone')
      return failureFrom(error)
    }
    try {
      await removeSource(from)
      deps.journal.advance(token, 'done')
    } catch (error) {
      // The verified copy is in place and the move stands. The journal stays `copied`: the next
      // boot deletes the source if it still matches the copy, and otherwise keeps both (a
      // partly deleted folder, or an edited copy). Undo refuses the move until then.
      deps.log.warn(`desktop: moved ${from} but could not delete the original yet`, error)
    }
    return null
  }

  async function moveOne(
    from: string,
    folders: ReturnType<FileOpsDeps['folders']>
  ): Promise<MoveOutcome> {
    const onDesktop = folders.some((folder) => pathKey(folder.path) === pathKey(dirname(from)))
    if (onDesktop) {
      try {
        return { from, ok: true, id: await fileIdOf(from), path: from, token: null }
      } catch (error) {
        return { from, ...failureFrom(error) }
      }
    }
    const destination = folders[0]
    if (!destination) return { from, ...failure('failed', 'no desktop folder') }
    if (destination.readonly) {
      return { from, ...failure('readonly', `${destination.path} cannot be changed by this user`) }
    }
    if (pathKey(destination.path).startsWith(`${pathKey(from)}\\`)) {
      return { from, ...failure('failed', `${from} contains the desktop`) }
    }

    let isDirectory: boolean
    try {
      isDirectory = (await lstat(from)).isDirectory()
    } catch (error) {
      return { from, ...failureFrom(error) }
    }
    try {
      const to = await freeName(destination.path, basename(from), isDirectory)
      const op = deps.journal.begin({ from, to })
      const failed = await transfer(op, isDirectory)
      if (failed) return { from, ...failed }
      const item = await deps.tracker.applyPresent(to)
      deps.log.info(`desktop: moved ${from} to ${to}`)
      return { from, ok: true, id: item?.id ?? (await fileIdOf(to)), path: to, token: op.token }
    } catch (error) {
      return { from, ...failureFrom(error) }
    }
  }

  return {
    async open(id) {
      const item = deps.model.get(id)
      if (!item) return notFound(id)
      try {
        if (item.kind === 'url' && item.url) {
          await deps.shell.openExternal(item.url)
          return { ok: true }
        }
        const error = await deps.shell.openPath(item.path)
        return error === '' ? { ok: true } : failure('failed', error)
      } catch (error) {
        return failure('failed', messageOf(error))
      }
    },

    async showInFolder(id) {
      const item = deps.model.get(id)
      if (!item) return notFound(id)
      deps.shell.showItemInFolder(item.path)
      return { ok: true }
    },

    async rename(id, newName) {
      const item = deps.model.get(id)
      if (!item) return notFound(id)
      if (item.readonly)
        return failure('readonly', `${item.path} is in a folder this user cannot change`)
      const invalid = validateFileName(newName)
      if (invalid) return failure(invalid, `"${newName}" cannot be a file name`)
      const target = join(dirname(item.path), newName)
      if (target === item.path) return { ok: true, path: target }
      try {
        deps.win32.moveFile(item.path, target)
      } catch (error) {
        return failureFrom(error)
      }
      await deps.tracker.applyRenamed(id, target)
      return { ok: true, path: target }
    },

    async trash(id) {
      const item = deps.model.get(id)
      if (!item) return notFound(id)
      if (item.readonly)
        return failure('readonly', `${item.path} is in a folder this user cannot change`)
      try {
        await deps.shell.trashItem(item.path)
      } catch (error) {
        return (await exists(item.path)) ? failure('failed', messageOf(error)) : notFound(id)
      }
      await deps.tracker.applyRemoved(id)
      return { ok: true }
    },

    async moveToDesktop(paths) {
      const folders = deps.folders()
      const moves: MoveOutcome[] = []
      // One at a time: each move is journaled and verified before the next starts.
      for (const path of paths) {
        // Checked as given: resolving first would turn a bare `E:` into that drive's cwd.
        moves.push(
          isVolumeOrShareRoot(path)
            ? { from: path, ...failure('failed', `${path} is a drive or share root; not moved`) }
            : await moveOne(win32.resolve(path), folders)
        )
      }
      return { moves }
    },

    async undoMove(token) {
      const op = deps.journal.get(token)
      if (!op) return failure('not-found', `no move ${token}`)
      if (op.state !== 'done') return failure('failed', `the move ${token} is ${op.state}`)
      if (!(await exists(op.to))) return failure('not-found', `${op.to} is gone`)
      if (await exists(op.from)) return failure('exists', `${op.from} exists again`)
      try {
        const id = deps.model.idAt(op.to)
        const isDirectory = (await lstat(op.to)).isDirectory()
        // The way back is a journaled move of its own, so a crash during it is replayed at boot.
        const back = deps.journal.begin({ from: op.to, to: op.from })
        const failed = await transfer(back, isDirectory)
        if (failed) return failed
        deps.journal.advance(token, 'undone')
        if (id !== undefined) await deps.tracker.applyRemoved(id)
        return { ok: true, path: op.from }
      } catch (error) {
        return failureFrom(error)
      }
    }
  }
}
