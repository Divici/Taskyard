import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, screen, shell } from 'electron'
import log from 'electron-log/main'
import { APP_ID, APP_NAME } from '@shared/app-info'
import { boot, STOP_BOOT } from './app/boot'
import { applyUserDataOverride, ENV, resolveLogLevel } from './app/env'
import { configureLogger, defaultLogDir, LOG_FILE_NAME } from './app/logger'
import { installQuitPath } from './app/quit-path'
import { acquireSingleInstanceLock } from './app/single-instance'
import { startDesktop } from './app/start-desktop'
import type { IpcEventEmitter } from './ipc/events'
import { registerIpcHandlers } from './ipc/handlers'
import { createSenderGuard } from './ipc/sender-guard'
import { replayJournal } from './storage/journal-replay'
import { createStorage } from './storage/stores'
import { createWin32Api } from './win32'
import type { RendererSource } from './windows/desktop-window'
import {
  createDesktopWindowManager,
  type DesktopWindowManager
} from './windows/desktop-window-manager'
import { registerDisplayIpc } from './windows/display-ipc'

const RENDERER_FILE = join(__dirname, '../renderer/index.html')
const PRELOAD_FILE = join(__dirname, '../preload/index.js')

// Order matters: userData must be final before the single-instance lock (which lives in
// userData) is requested and before the logger writes to userData/logs.
applyUserDataOverride(app, process.env)

if (acquireSingleInstanceLock(app, onSecondInstance)) {
  startPrimaryInstance()
}

function onSecondInstance(): void {
  // Phase 9 turns a second launch into Peek.
  log.info('app: second-instance received')
}

function startPrimaryInstance(): void {
  const logDir = defaultLogDir(app.getPath('userData'))
  configureLogger(log, {
    logDir,
    level: resolveLogLevel(process.env[ENV.logLevel])
  })
  log.errorHandler.startCatching({ showDialog: false })
  log.info(`app: starting ${APP_NAME} ${app.getVersion()} (${app.isPackaged ? 'packaged' : 'dev'})`)

  // Starts before `ready` so koffi loads (and the user32 probe logs) while Electron boots.
  const win32 = createWin32Api({
    env: process.env,
    platform: process.platform,
    isPackaged: app.isPackaged,
    log,
    importKoffi: async () => (await import('koffi')).default
  })

  const renderer = rendererSource()
  // Only frames showing our renderer may call main: index.html (any ?displayId=) or, in dev, the
  // dev server the desktop windows load.
  const trust = {
    isTrustedSender: createSenderGuard({
      rendererFile: RENDERER_FILE,
      devServerUrl: renderer.kind === 'url' ? renderer.url : undefined
    }),
    log
  }

  let desktop: DesktopWindowManager | null = null
  // Every main → renderer event goes to the desktop windows through the manager's one broadcast
  // (none exist before step 3 of boot; renderers pull what they missed when they hydrate).
  const events: IpcEventEmitter = { emit: (event, payload) => desktop?.emit(event, payload) ?? 0 }

  // Every accepted save — any window's, or main's own — reaches every window, the saver too,
  // with its new revision (optimistic concurrency; the client side is src/shared/sync-doc.ts).
  const storage = createStorage({
    dir: app.getPath('userData'),
    log,
    onChange: (change) => events.emit('storage:changed', change)
  })

  registerIpcHandlers(ipcMain, {
    storage,
    isTrustedSender: trust.isTrustedSender,
    openExternal: (url) => shell.openExternal(url),
    quit: () => app.quit(),
    log
  })
  // Flush before quit, desktop windows marked quitting only when the quit really proceeds (and
  // guarded again if it is cancelled), session-end flush, window-all-closed guard.
  installQuitPath(app, { storage, desktop: () => desktop, log })

  // LOCKED order: stores load → journal replay → windows → scan → watch. Stores load and the
  // journal replays while Electron initialises; the windows wait for ready. Without desktop
  // windows nothing after them runs and the app quits (never a windowless process holding the
  // single-instance lock).
  void boot(
    {
      loadStores: () => storage.loadAll(),
      replayJournal: () =>
        replayJournal({ journal: storage.ops, layout: storage.layout, emit: events.emit, log }),
      createWindows: async () => {
        await app.whenReady()
        app.setAppUserModelId(APP_ID)
        // Win32 unavailable or a failed start → error dialog + quit, never a half-running app.
        desktop = startDesktop(await win32, {
          clearApplicationMenu: () => Menu.setApplicationMenu(null),
          createManager: (api) =>
            createDesktopWindowManager({
              electron: { BrowserWindow, screen, powerMonitor },
              api,
              preloadPath: PRELOAD_FILE,
              renderer,
              log,
              requestQuit: () => app.quit(),
              devTools: !app.isPackaged
            }),
          registerIpc: (manager) => registerDisplayIpc(ipcMain, manager, trust),
          showErrorBox: (title, content) => dialog.showErrorBox(title, content),
          quit: () => app.quit(),
          log,
          logFile: join(logDir, LOG_FILE_NAME)
        })
        // null: startDesktop explained why in a dialog and is quitting; no scan, no watch.
        return desktop ?? STOP_BOOT
      },
      // Phase 4 plugs in the desktop scanner and the file watcher.
      scan: () => {},
      watch: () => {}
    },
    log,
    // createWindows threw outside startDesktop (already logged by boot): quit.
    { onFatal: () => app.quit() }
  )
}

function rendererSource(): RendererSource {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) return { kind: 'url', url: devServerUrl }
  return { kind: 'file', path: RENDERER_FILE }
}
