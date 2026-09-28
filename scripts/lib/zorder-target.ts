import { join } from 'node:path'

/** Where `npm run dist` leaves the unpacked app, relative to the repo root. */
export const PACKAGED_EXE = join('dist', 'win-unpacked', 'Taskyard.exe')

export interface ZorderTarget {
  /** dev: electron.exe + out/main; packaged: a Taskyard.exe. */
  kind: 'dev' | 'packaged'
  command: string
  args: string[]
  /** Run `npm run build` first (dev only, unless --no-build). */
  build: boolean
  /** What the log says it launched. */
  label: string
}

/**
 * What verify:zorder launches: the dev build by default; `--packaged` for the unpacked app from
 * `npm run dist` (Phase 12 acceptance); `--exe <path>` for any Taskyard.exe (the installed copy).
 */
export function zorderTarget(
  argv: readonly string[],
  root: string,
  dev: { electron: string; main: string }
): ZorderTarget {
  const exeAt = argv.indexOf('--exe')
  if (exeAt !== -1) {
    const exe = argv[exeAt + 1]
    if (!exe || exe.startsWith('--')) throw new Error('verify:zorder: --exe needs a path')
    return { kind: 'packaged', command: exe, args: [], build: false, label: exe }
  }
  if (argv.includes('--packaged')) {
    const exe = join(root, PACKAGED_EXE)
    return { kind: 'packaged', command: exe, args: [], build: false, label: exe }
  }
  return {
    kind: 'dev',
    command: dev.electron,
    args: [dev.main],
    build: !argv.includes('--no-build'),
    label: dev.main
  }
}
