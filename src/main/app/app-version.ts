import { version } from '../../../package.json'

/**
 * Taskyard's version. `app.getVersion()` reads the app's package.json, but when main is started
 * as a bare script (`electron out/main/index.js`, as the e2e runs do) Electron has none and
 * answers with its own version; the bundled package.json version is Taskyard's there.
 */
export function appVersion(app: { isPackaged: boolean; getVersion(): string }): string {
  return app.isPackaged ? app.getVersion() : version
}
