import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { APP_ID, APP_NAME } from '@shared/app-info'
import { applyUserDataOverride, ENV, resolveLogLevel } from './app/env'
import { configureLogger, defaultLogDir } from './app/logger'
import { acquireSingleInstanceLock } from './app/single-instance'
import { loadUser32 } from './win32/load-user32'
import { forwardRendererConsole } from './windows/renderer-console'
import { placeholderWindowOptions } from './windows/window-options'

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
  configureLogger(log, {
    logDir: defaultLogDir(app.getPath('userData')),
    level: resolveLogLevel(process.env[ENV.logLevel])
  })
  log.errorHandler.startCatching({ showDialog: false })
  log.info(`app: starting ${APP_NAME} ${app.getVersion()} (${app.isPackaged ? 'packaged' : 'dev'})`)

  void loadUser32({
    importKoffi: async () => (await import('koffi')).default,
    isPackaged: app.isPackaged,
    log
  })

  void app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID)
    createPlaceholderWindow()
  })

  app.on('window-all-closed', () => app.quit())
}

function createPlaceholderWindow(): BrowserWindow {
  const window = new BrowserWindow(placeholderWindowOptions(join(__dirname, '../preload/index.js')))

  window.once('ready-to-show', () => {
    window.show()
    log.info(`window: shown "${window.getTitle()}"`)
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  forwardRendererConsole(window.webContents, log)
  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('window: renderer process gone', details)
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    log.error(`window: preload failed (${preloadPath})`, error)
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}
