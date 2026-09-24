import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, screen } from 'electron'
import log from 'electron-log/main'
import { APP_ID, APP_NAME } from '@shared/app-info'
import { applyUserDataOverride, ENV, resolveLogLevel } from './app/env'
import { configureLogger, defaultLogDir, LOG_FILE_NAME } from './app/logger'
import { acquireSingleInstanceLock } from './app/single-instance'
import { startDesktop } from './app/start-desktop'
import { createWin32Api } from './win32'
import type { RendererSource } from './windows/desktop-window'
import {
  createDesktopWindowManager,
  type DesktopWindowManager
} from './windows/desktop-window-manager'
import { registerDisplayIpc } from './windows/display-ipc'

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

  let desktop: DesktopWindowManager | null = null

  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId(APP_ID)
      desktop = startDesktop(await win32, {
        clearApplicationMenu: () => Menu.setApplicationMenu(null),
        createManager: (api) =>
          createDesktopWindowManager({
            electron: { BrowserWindow, screen, powerMonitor },
            api,
            preloadPath: join(__dirname, '../preload/index.js'),
            renderer: rendererSource(),
            log,
            requestQuit: () => app.quit()
          }),
        registerIpc: (manager) => registerDisplayIpc(ipcMain, manager),
        showErrorBox: (title, content) => dialog.showErrorBox(title, content),
        quit: () => app.quit(),
        log,
        logFile: join(logDir, LOG_FILE_NAME)
      })
    })
    .catch((error: unknown) => {
      log.error('app: startup failed', error)
      app.quit()
    })

  // Desktop windows refuse outside closes (Alt+F4) until the app itself is quitting.
  app.on('before-quit', () => {
    log.info('app: before-quit')
    desktop?.prepareToQuit()
  })
  app.on('will-quit', () => desktop?.dispose())
  // A window destroyed from outside is recreated by the manager, so only quit when quitting.
  app.on('window-all-closed', () => {
    if (desktop === null || desktop.quitting) app.quit()
  })
}

function rendererSource(): RendererSource {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) return { kind: 'url', url: devServerUrl }
  return { kind: 'file', path: join(__dirname, '../renderer/index.html') }
}
