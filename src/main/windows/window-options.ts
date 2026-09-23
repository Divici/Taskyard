import type { BrowserWindowConstructorOptions, WebPreferences } from 'electron'
import { APP_NAME } from '@shared/app-info'

/** Renderer isolation shared by every Taskyard window. */
export function secureWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    // Sandboxed preloads may only require('electron'); webUtils stays available for file drops.
    sandbox: true,
    webSecurity: true
  }
}

/** The Phase 1 placeholder window; Phase 2 replaces it with one desktop window per display. */
export function placeholderWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    title: APP_NAME,
    width: 1024,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    // Matches the light --background token so the first paint does not flash.
    backgroundColor: '#ffffff',
    webPreferences: secureWebPreferences(preloadPath)
  }
}
