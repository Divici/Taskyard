// Runs sandboxed (sandbox: true): only `electron` and a few polyfilled builtins can be required,
// so electron-vite bundles this file into a single self-contained CommonJS script.
import { contextBridge } from 'electron'
import type { TaskyardApi } from './api'

const api: TaskyardApi = {
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
}

contextBridge.exposeInMainWorld('taskyard', api)
