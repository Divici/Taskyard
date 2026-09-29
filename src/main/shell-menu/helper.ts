/**
 * The shell-menu helper: an Electron utility process (bundled as out/main/shell-menu-helper.js,
 * forked by app-shell-menu.ts). It loads koffi, joins a COM single-threaded apartment and serves
 * main's show / enumerate / invoke requests over `process.parentPort`. Shell extensions load
 * into this process, not Taskyard's main process: one that crashes takes only the helper down,
 * and TrackPopupMenuEx's modal loop blocks only this thread. See helper-core.ts for the logic.
 */
import type { Koffi } from '../win32/bindings'
import { createKoffiShellMenuApi } from '../win32/shell-menu-koffi'
import { runHelper, warmUpShellMenu } from './helper-core'

void runHelper({
  port: process.parentPort,
  process,
  createApi: async (log) =>
    createKoffiShellMenuApi((await import('koffi')).default as Koffi, { log }),
  // Read-only: builds (never shows) the Desktop background menu so the handlers are loaded
  // before the user's first right-click.
  warmUp: warmUpShellMenu
})
