import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  powerMonitor,
  protocol,
  screen,
  shell
} from 'electron'
import log from 'electron-log/main'
import { APP_ID, APP_NAME } from '@shared/app-info'
import { boot, STOP_BOOT } from './app/boot'
import { applyUserDataOverride, ENV, resolveLogLevel } from './app/env'
import { configureLogger, defaultLogDir, LOG_FILE_NAME } from './app/logger'
import { installQuitPath } from './app/quit-path'
import { acquireSingleInstanceLock } from './app/single-instance'
import { startDesktop } from './app/start-desktop'
import { createThemeService, registerThemeIpc, type ThemeService } from './app/theme-service'
import { registerDesktopIpc } from './desktop/desktop-ipc'
import { resolveDesktopDirs } from './desktop/desktop-dirs'
import { createDesktopService, type DesktopService } from './desktop/desktop-service'
import { registerWallpaperIpc } from './desktop/wallpaper-ipc'
import {
  createWallpaperService,
  nodeWallpaperFs,
  TASKYARD_SCHEME,
  TASKYARD_SCHEME_PRIVILEGES,
  watchThemesFolder,
  type WallpaperService
} from './desktop/wallpaper-service'
import type { IpcEventEmitter } from './ipc/events'
import { registerIpcHandlers } from './ipc/handlers'
import { createSenderGuard } from './ipc/sender-guard'
import { replayJournal } from './storage/journal-replay'
import { createStorage } from './storage/stores'
import { createWin32Api } from './win32'
import type { Win32Api } from './win32/api'
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

// taskyard://wallpaper/<displayId> serves each display's wallpaper to its window. A scheme can
// only be made privileged before `ready`.
protocol.registerSchemesAsPrivileged([
  { scheme: TASKYARD_SCHEME, privileges: { ...TASKYARD_SCHEME_PRIVILEGES } }
])

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
  // The desktop folders' items (Phase 4). The service needs the Win32 api, which exists once the
  // windows do, so it is created in the scan step; desktop:* requests wait for it.
  const desktopDirs = resolveDesktopDirs({ env: process.env, userDesktop: app.getPath('desktop') })
  let desktopFiles: DesktopService | null = null
  let desktopFilesReady: (service: DesktopService) => void = () => {}
  const desktopFilesPromise = new Promise<DesktopService>(
    (resolve) => (desktopFilesReady = resolve)
  )
  registerDesktopIpc(ipcMain, trust, () => desktopFilesPromise)

  // Phase 6: the wallpaper layer and the theme. The wallpaper service needs Win32 and the screen
  // (both after ready), so wallpaper:get requests wait for it; the theme needs nativeTheme.
  let wallpaper: WallpaperService | null = null
  let wallpaperReady: (service: WallpaperService) => void = () => {}
  const wallpaperPromise = new Promise<WallpaperService>((resolve) => (wallpaperReady = resolve))
  registerWallpaperIpc(ipcMain, () => wallpaperPromise, trust)
  let theme: ThemeService | null = null
  registerThemeIpc(ipcMain, { current: () => (theme ??= createTheme()).current() }, trust)
  function createTheme(): ThemeService {
    return createThemeService({ nativeTheme, emit: (info) => events.emit('theme:changed', info) })
  }

  // Flush before quit, desktop windows marked quitting only when the quit really proceeds (and
  // guarded again if it is cancelled), session-end flush, window-all-closed guard, and the
  // desktop watcher stopped at will-quit.
  installQuitPath(app, {
    storage,
    desktop: () => desktop,
    log,
    stopWatching: async () => {
      theme?.stop()
      await Promise.all([desktopFiles?.stop(), wallpaper?.stop()])
    }
  })

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
        const selection = await win32
        theme ??= createTheme()
        theme.start()
        if (selection.kind !== 'unavailable') wallpaper = startWallpaper(selection.api)
        // Win32 unavailable or a failed start → error dialog + quit, never a half-running app.
        desktop = startDesktop(selection, {
          clearApplicationMenu: () => Menu.setApplicationMenu(null),
          createManager: (api) =>
            createDesktopWindowManager({
              electron: { BrowserWindow, screen, powerMonitor },
              api,
              preloadPath: PRELOAD_FILE,
              renderer,
              log,
              requestQuit: () => app.quit(),
              devTools: !app.isPackaged,
              // Wallpaper, theme or transparency may have changed.
              onSettingChange: () => {
                wallpaper?.settingChanged()
                theme?.check()
              }
            }),
          registerIpc: (manager) => registerDisplayIpc(ipcMain, manager, trust),
          showErrorBox: (title, content) => dialog.showErrorBox(title, content),
          quit: () => app.quit(),
          log,
          logFile: join(logDir, LOG_FILE_NAME)
        })
        // null: startDesktop explained why in a dialog and is quitting; no scan, no watch.
        if (desktop === null) return STOP_BOOT
        void wallpaper?.start()
        return desktop
      },
      // The full list goes to every window as desktop:changed; a window that loads later pulls
      // it with desktop:list (which waits for this scan).
      scan: async () => {
        const selection = await win32
        if (selection.kind === 'unavailable') return STOP_BOOT
        desktopFiles = createDesktopService({
          dirs: desktopDirs,
          win32: selection.api,
          shell: {
            openPath: (path) => shell.openPath(path),
            openExternal: (url) => shell.openExternal(url),
            showItemInFolder: (path) => shell.showItemInFolder(path),
            trashItem: (path) => shell.trashItem(path),
            readShortcutLink: (path) => shell.readShortcutLink(path)
          },
          journal: storage.ops,
          layout: storage.layout,
          emit: (event, payload) => events.emit(event, payload),
          env: process.env,
          log
        })
        desktopFilesReady(desktopFiles)
        await desktopFiles.scan()
        return undefined
      },
      // Started after the scan, so the watcher's model is the scanned one.
      watch: () => desktopFiles?.watch()
    },
    log,
    // createWindows threw outside startDesktop (already logged by boot): quit.
    { onFatal: () => app.quit() }
  )

  /** The wallpaper service, its taskyard:// handler, and a refresh on every display change. */
  function startWallpaper(api: Win32Api): WallpaperService {
    const service = createWallpaperService({
      api,
      displays: () => screen.getAllDisplays(),
      toScreenRect: (bounds) => screen.dipToScreenRect(null, bounds),
      themesDir: join(app.getPath('appData'), 'Microsoft', 'Windows', 'Themes'),
      fs: nodeWallpaperFs,
      emit: (payload) => events.emit('wallpaper:changed', payload),
      log,
      watchThemes: watchThemesFolder
    })
    protocol.handle(TASKYARD_SCHEME, (request) => service.handle(request.url))
    // Displays added, removed, moved or rescaled: every rect (and span's virtual screen) changes.
    const refresh = (): void => service.settingChanged()
    screen.on('display-added', refresh)
    screen.on('display-removed', refresh)
    screen.on('display-metrics-changed', refresh)
    wallpaperReady(service)
    return service
  }
}

function rendererSource(): RendererSource {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) return { kind: 'url', url: devServerUrl }
  return { kind: 'file', path: RENDERER_FILE }
}
