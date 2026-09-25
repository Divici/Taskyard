import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  protocol,
  screen,
  shell
} from 'electron'
import log from 'electron-log/main'
import { APP_ID, APP_NAME } from '@shared/app-info'
import type { DesktopIcon } from '@shared/ipc'
import { boot, STOP_BOOT } from './app/boot'
import { applyUserDataOverride, ENV, resolveLogLevel } from './app/env'
import { configureLogger, defaultLogDir, LOG_FILE_NAME } from './app/logger'
import { installQuitPath } from './app/quit-path'
import { createQuickHide, registerQuickHideIpc } from './app/quick-hide'
import { createPeekShortcuts, registerPeekIpc, type PeekShortcuts } from './app/shortcuts'
import { acquireSingleInstanceLock } from './app/single-instance'
import { startDesktop } from './app/start-desktop'
import { createTimerNotifier, registerTimerIpc } from './app/notifications'
import { createThemeService, registerThemeIpc, type ThemeService } from './app/theme-service'
import { registerDesktopIpc } from './desktop/desktop-ipc'
import { cursorOverOtherWindow, registerDragOutIpc } from './desktop/dnd-ipc'
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
import { createIconService, type IconService } from './desktop/icon-service'
import type { IpcEventEmitter } from './ipc/events'
import { registerIpcHandlers } from './ipc/handlers'
import { createSenderGuard } from './ipc/sender-guard'
import { replayJournal } from './storage/journal-replay'
import { createStorage } from './storage/stores'
import { createWin32Api } from './win32'
import type { Win32Api } from './win32/api'
import { iconBitmapToPng } from './win32/icon-bitmap'
import { hwndFromHandle, type RendererSource } from './windows/desktop-window'
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

/** Phase 9: set once Peek exists (startPrimaryInstance); Phase 11's tray uses `togglePeek`. */
let peekShortcuts: PeekShortcuts | null = null

if (acquireSingleInstanceLock(app, onSecondInstance)) {
  startPrimaryInstance()
}

function onSecondInstance(): void {
  // A second launch means the user is looking for Taskyard: Peek shows it over their apps.
  log.info('app: second-instance received, peeking')
  peekShortcuts?.showPeek()
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

  // Phase 9: Peek's global shortcut (settings.peekShortcut, rebindable), its renderer signals, and
  // quick-hide shared by every display. The window manager owns Peek itself.
  const shortcuts = createPeekShortcuts({
    globalShortcut,
    target: () => desktop,
    emit: (status) => events.emit('peek:shortcut', status),
    log
  })
  peekShortcuts = shortcuts
  const quickHide = createQuickHide({ emit: (event, payload) => events.emit(event, payload) })

  // Every accepted save — any window's, or main's own — reaches every window, the saver too,
  // with its new revision (optimistic concurrency; the client side is src/shared/sync-doc.ts).
  const storage = createStorage({
    dir: app.getPath('userData'),
    log,
    onChange: (change) => {
      events.emit('storage:changed', change)
      // Phase 9 (and Phase 11's Settings UI): a changed peekShortcut is registered at once.
      if (change.store === 'settings') shortcuts.applySettings(change.data)
    }
  })

  registerIpcHandlers(ipcMain, {
    storage,
    isTrustedSender: trust.isTrustedSender,
    openExternal: (url) => shell.openExternal(url),
    quit: () => app.quit(),
    log
  })
  registerPeekIpc(ipcMain, trust, { shortcuts, peeking: () => desktop?.peeking ?? false })
  registerQuickHideIpc(ipcMain, trust, quickHide)
  app.on('will-quit', () => shortcuts.dispose())
  // The desktop folders' items (Phase 4). The service needs the Win32 api, which exists once the
  // windows do, so it is created in the scan step; desktop:* requests wait for it.
  const desktopDirs = resolveDesktopDirs({ env: process.env, userDesktop: app.getPath('desktop') })
  let desktopFiles: DesktopService | null = null
  // Phase 5: icons for the desktop items, streamed as desktop:icon (created with the service).
  let stopIcons: () => void = () => {}
  let desktopFilesReady: (service: DesktopService) => void = () => {}
  const desktopFilesPromise = new Promise<DesktopService>(
    (resolve) => (desktopFilesReady = resolve)
  )
  registerDesktopIpc(ipcMain, trust, () => desktopFilesPromise)
  // Phase 8: dragging items out to other apps (the renderer cancels its own drag first).
  registerDragOutIpc(ipcMain, trust, {
    paths: async (ids) => (await desktopFilesPromise).pathsOf(ids),
    icon: (ids, files) => dragIcon(ids, files),
    startDrag: (event, item) =>
      (event.sender as Electron.WebContents).startDrag(item as Electron.Item),
    cursorOverOtherWindow: async (event) => {
      const selection = await win32
      if (selection.kind === 'unavailable') return false
      const owner = BrowserWindow.fromWebContents(event.sender as Electron.WebContents)
      const own =
        owner && !owner.isDestroyed() ? hwndFromHandle(owner.getNativeWindowHandle()) : null
      return cursorOverOtherWindow(selection.api, own)
    },
    primaryButtonDown: async () => {
      const selection = await win32
      return selection.kind !== 'unavailable' && selection.api.isPrimaryButtonDown()
    }
  })
  /** The first dragged item's icon (as streamed to the renderers), else Windows' file icon. */
  async function dragIcon(ids: string[], files: string[]): Promise<Electron.NativeImage | null> {
    const sent = desktopFiles?.icons().find((icon) => icon.id === ids[0] && icon.dataUrl !== null)
    if (sent?.dataUrl) {
      const image = nativeImage.createFromDataURL(sent.dataUrl)
      if (!image.isEmpty()) return image
    }
    try {
      return await app.getFileIcon(files[0], { size: 'normal' })
    } catch (error) {
      log.warn('dnd: no file icon for the drag', error)
      return null
    }
  }

  // Phase 10: a finished countdown's Windows notification (Settings › timerNotify, read when the
  // timer ends). The tray's tools toggle and timer tooltip live in app/tools-control.ts.
  registerTimerIpc(
    ipcMain,
    createTimerNotifier({
      settings: () => storage.settings.get(),
      createNotification: (options) => new Notification(options),
      isSupported: () => Notification.isSupported(),
      log
    }),
    trust
  )
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
      stopIcons()
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
        // Phase 9: the Peek shortcut, once the app is ready and the settings are loaded.
        shortcuts.start(storage.settings.get())
        void wallpaper?.start()
        return desktop
      },
      // The full list goes to every window as desktop:changed; a window that loads later pulls
      // it with desktop:list (which waits for this scan).
      scan: async () => {
        const selection = await win32
        if (selection.kind === 'unavailable') return STOP_BOOT
        const icons = startIcons(selection.api, (event, payload) => events.emit(event, payload))
        stopIcons = icons.stop
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
          log,
          icons: icons.service
        })
        desktopFilesReady(desktopFiles)
        await desktopFiles.scan()
        logIconBootPass(icons.service)
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

/**
 * Phase 5: the icon pipeline over Electron's 32 px icons, Win32 extraction and the disk cache in
 * userData/icons. It follows the displays: a larger max scale factor re-extracts at the new size.
 */
function startIcons(
  win32: Win32Api,
  emit: (event: 'desktop:icon', payload: DesktopIcon) => unknown
): { service: IconService; stop: () => void } {
  const service = createIconService({
    cacheDir: join(app.getPath('userData'), 'icons'),
    fs: { readFile, writeFile, rename, mkdir, readdir, unlink, stat },
    win32,
    getFileIcon: async (path) => {
      const image = await app.getFileIcon(path, { size: 'normal' })
      if (image.isEmpty()) throw new Error('Electron returned an empty icon')
      return image.toPNG()
    },
    encodePng: (icon) => iconBitmapToPng(icon, nativeImage),
    scaleFactors: () => screen.getAllDisplays().map((display) => display.scaleFactor),
    emit,
    log,
    systemRoot: process.env['SystemRoot'] ?? 'C:\\Windows'
  })
  const refresh = (): void => service.refreshScale()
  screen.on('display-added', refresh)
  screen.on('display-removed', refresh)
  screen.on('display-metrics-changed', refresh)
  const stop = (): void => {
    screen.removeListener('display-added', refresh)
    screen.removeListener('display-removed', refresh)
    screen.removeListener('display-metrics-changed', refresh)
    service.stop()
  }
  return { service, stop }
}

/** Logs the boot icon pass once it drains, then prunes icons of items gone since last time. */
function logIconBootPass(service: IconService): void {
  const started = performance.now()
  void service.idle().then(async () => {
    const { cached, shell: fetched, extracted, generic, failed } = service.stats()
    const ms = Math.round(performance.now() - started)
    log.info(
      `icons: boot pass ${ms} ms at ${service.px} px (${cached} cached, ${fetched} from Electron, ` +
        `${extracted} extracted, ${generic} generic, ${failed} failed)`
    )
    await service.prune()
  })
}

function rendererSource(): RendererSource {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) return { kind: 'url', url: devServerUrl }
  return { kind: 'file', path: RENDERER_FILE }
}
