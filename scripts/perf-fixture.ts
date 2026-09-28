/**
 * Phase 12 performance fixture: a 200-item desktop (150 `.lnk`) laid out in 12 groups.
 *
 *   tsx scripts/perf-fixture.ts <empty folder>   writes the desktop items into the folder
 *
 * e2e/perf.spec.ts builds it in temp folders (TASKYARD_DESKTOP_DIRS + TASKYARD_USER_DATA), never
 * on the real desktop. The shortcuts point at real programs in System32, so the icon pipeline
 * does its real work (Electron's 32 px icon, then the Win32 extraction at the display size).
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { newDisplayLayout, emptyLayout } from '../src/shared/defaults'
import type { Group, LayoutFile, Rect } from '../src/shared/schema'
import { writeLnk } from '../src/main/desktop/test/lnk-writer'

/** Same mix as the scanner bench (this machine is 77 % shortcuts). */
export const PERF_COUNTS = { links: 150, urls: 20, files: 15, folders: 10, apps: 5, total: 200 }
export const PERF_GROUPS = 12

const SYSTEM32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')
/** Programs every Windows 11 install has; each shortcut targets one of them. */
const TARGETS = [
  'notepad.exe',
  'calc.exe',
  'winver.exe',
  'cmd.exe',
  'charmap.exe',
  'mstsc.exe',
  'taskmgr.exe',
  'regedit.exe',
  'magnify.exe',
  'osk.exe'
].map((exe) => (exe === 'regedit.exe' ? join(SYSTEM32, '..', exe) : join(SYSTEM32, exe)))

/** Writes the 200 items into `dir` (which must exist) and returns their paths. */
export function writePerfDesktop(dir: string): string[] {
  const paths: string[] = []
  const add = (name: string, write: (path: string) => void): void => {
    const path = join(dir, name)
    write(path)
    paths.push(path)
  }
  for (let i = 0; i < PERF_COUNTS.links; i++) {
    const target = TARGETS[i % TARGETS.length]
    add(`App ${i}.lnk`, (path) => writeFileSync(path, writeLnk({ localBasePath: target })))
  }
  for (let i = 0; i < PERF_COUNTS.urls; i++) {
    add(`Site ${i}.url`, (path) =>
      writeFileSync(path, `[InternetShortcut]\r\nURL=https://example.com/${i}\r\n`)
    )
  }
  for (let i = 0; i < PERF_COUNTS.files; i++) {
    add(`Document ${i}.txt`, (path) => writeFileSync(path, `document ${i}\n`))
  }
  for (let i = 0; i < PERF_COUNTS.folders; i++) {
    add(`Folder ${i}`, (path) => mkdirSync(path))
  }
  for (let i = 0; i < PERF_COUNTS.apps; i++) {
    add(`tool${i}.exe`, (path) => writeFileSync(path, 'MZ'))
  }
  return paths
}

export interface PerfDisplay {
  id: number
  /** Electron's display bounds (DIP). */
  bounds: Rect
  /** The work area in window coordinates (the display's top-left is 0,0). */
  workArea: Rect
}

const MARGIN = 16
const COLUMNS = 4
const ROWS = 3

/**
 * The layout: 12 groups in a 4 × 3 grid filling the work area, the items dealt round-robin into
 * them (about 17 each), no loose icons, the tools widget hidden so it covers no group.
 */
export function perfLayout(
  ids: readonly string[],
  paths: Readonly<Record<string, string>>,
  display: PerfDisplay
): LayoutFile {
  const area = display.workArea
  const w = Math.floor((area.width - MARGIN * (COLUMNS + 1)) / COLUMNS)
  const h = Math.floor((area.height - MARGIN * (ROWS + 1)) / ROWS)
  const groups: Group[] = Array.from({ length: PERF_GROUPS }, (_, index) => ({
    id: `perf-${index}`,
    title: `Group ${index + 1}`,
    x: area.x + MARGIN + (index % COLUMNS) * (w + MARGIN),
    y: area.y + MARGIN + Math.floor(index / COLUMNS) * (h + MARGIN),
    w,
    h,
    z: index + 1,
    rolledUp: false,
    items: ids.filter((_, i) => i % PERF_GROUPS === index),
    sort: 'manual',
    excludeFromQuickHide: false,
    createdAt: 1
  }))
  return {
    ...emptyLayout(),
    displays: [
      { ...newDisplayLayout(display.id, display.bounds, { visible: false }), groups, loose: {} }
    ],
    paths: { ...paths }
  }
}

function main(): number {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: tsx scripts/perf-fixture.ts <empty folder>')
    return 1
  }
  const target = resolve(dir)
  if (!existsSync(target)) mkdirSync(target, { recursive: true })
  if (readdirSync(target).length > 0) {
    console.error(`perf-fixture: ${target} is not empty; refusing to write into it`)
    return 1
  }
  const paths = writePerfDesktop(target)
  console.log(`perf-fixture: ${paths.length} items (${PERF_COUNTS.links} .lnk) in ${target}`)
  return 0
}

if (require.main === module) process.exitCode = main()
