// Runs sandboxed (sandbox: true): only `electron` and a few polyfilled builtins can be required,
// so electron-vite bundles this file (and @shared/ipc, which is zod-free) into a single
// self-contained CommonJS script. No `clipboard` here: "Copy path" uses navigator.clipboard.
import { contextBridge, ipcRenderer } from 'electron'
import { createTaskyardApi } from './bridge'

contextBridge.exposeInMainWorld(
  'taskyard',
  createTaskyardApi(ipcRenderer, {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  })
)
