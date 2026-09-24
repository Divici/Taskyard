import type { WebPreferences } from 'electron'

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
