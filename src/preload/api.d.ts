/** Surface the sandboxed preload exposes to the renderer as `window.taskyard`. */
export interface TaskyardApi {
  versions: {
    electron: string
    chrome: string
    node: string
  }
}

declare global {
  interface Window {
    taskyard: TaskyardApi
  }
}
