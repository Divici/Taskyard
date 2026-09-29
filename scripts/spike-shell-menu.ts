/**
 * npm run spike:shell-menu — the native-menus gate (plan 2026-09-29, Phase 2). Interactive
 * Windows only; it briefly moves the mouse and presses keys in a window of its own.
 *
 * Part A (this process, koffi): builds and reads — never shows, never invokes — the background
 * menu of the real Desktop and of a TEMP folder through all three candidate APIs (shell-view,
 * view-object, default-menu), and the menus of one and two TEMP files. Writes item lists.
 *
 * Part B (Electron): builds the app (unless --skip-build), bundles
 * scripts/lib/spike-shell-menu-electron.ts and runs it: the real helper process shows a working
 * menu (foreground, keyboard, live New ▸), is dismissed programmatically, invokes a verb without
 * a menu, survives a failing request and is respawned after being killed. TEMP files only.
 *
 * Options: --out <dir> (default: a new temp folder), --skip-build, --part-a-only.
 * Exit 0 when every check passes.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import type { Koffi } from '../src/main/win32/bindings'
import type {
  BackgroundSource,
  ShellMenuItem,
  ShellMenuTarget
} from '../src/main/win32/shell-menu-api'
import { createKoffiShellMenuApi } from '../src/main/win32/shell-menu-koffi'

const ROOT = resolve(__dirname, '..')
const HELPER = join(ROOT, 'out', 'main', 'shell-menu-helper.js')
const BUNDLE = join(ROOT, 'out', 'spike', 'spike-shell-menu-electron.cjs')
const ELECTRON_TIMEOUT_MS = 180_000
const SOURCES: BackgroundSource[] = ['shell-view', 'view-object', 'default-menu']

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index >= 0 ? (process.argv[index + 1] ?? null) : null
}

function log(message: string): void {
  console.log(`spike:shell-menu: ${message}`)
}

/** An indented item list: label, [verb], ▸ for submenus, --- for separators. */
function describeMenu(items: ShellMenuItem[], depth = 0): string[] {
  return items.flatMap((item) => {
    const indent = '  '.repeat(depth + 1)
    if (item.separator) return [`${indent}---`]
    const verb = item.verb ? `  [${item.verb}]` : ''
    const flags = `${item.disabled ? ' (disabled)' : ''}${item.checked ? ' (checked)' : ''}`
    const line = `${indent}${item.label}${item.submenu ? ' ▸' : ''}${verb}${flags}`
    return [line, ...(item.submenu ? describeMenu(item.submenu, depth + 1) : [])]
  })
}

function verbsOf(items: ShellMenuItem[]): string[] {
  return items.flatMap((item) => [
    ...(item.verb ? [item.verb] : []),
    ...verbsOf(item.submenu ?? [])
  ])
}

interface Enumeration {
  name: string
  target: ShellMenuTarget
  source?: BackgroundSource
  ms: number
  items: ShellMenuItem[]
}

async function partA(dir: string, out: string): Promise<{ ok: boolean; runs: Enumeration[] }> {
  const koffi = (await import('koffi')).default as unknown as Koffi
  const api = createKoffiShellMenuApi(koffi, { log: { warn: (m, ...d) => console.warn(m, ...d) } })
  const runs: Enumeration[] = []
  const run = (name: string, target: ShellMenuTarget, source?: BackgroundSource): Enumeration => {
    const started = performance.now()
    const items = api.enumerate(target, { extendedVerbs: false, source })
    const entry = { name, target, source, ms: Math.round(performance.now() - started), items }
    runs.push(entry)
    return entry
  }
  try {
    for (const source of SOURCES)
      run(`Desktop background (${source})`, { kind: 'desktop-background' }, source)
    // A second shell-view build: handlers that load late (Open in Terminal) show up here.
    run('Desktop background (shell-view, again)', { kind: 'desktop-background' }, 'shell-view')
    for (const source of SOURCES)
      run(`TEMP folder background (${source})`, { kind: 'folder-background', path: dir }, source)
    run('One TEMP file', { kind: 'items', paths: [join(dir, 'a.txt')] })
    run('Two TEMP files (same folder)', {
      kind: 'items',
      paths: [join(dir, 'a.txt'), join(dir, 'b.txt')]
    })
  } finally {
    api.dispose()
  }

  const text = runs
    .map((entry) =>
      [
        `== ${entry.name} — ${entry.ms} ms, ${entry.items.length} top-level entries`,
        ...describeMenu(entry.items)
      ].join('\n')
    )
    .join('\n\n')
  writeFileSync(join(out, 'item-lists.txt'), `${text}\n`)
  writeFileSync(join(out, 'part-a.json'), JSON.stringify(runs, null, 2))
  console.log(text)

  const wanted = ['NewFolder', 'paste', 'Display', 'Personalize']
  let ok = true
  for (const entry of runs.filter((e) => e.target.kind === 'desktop-background')) {
    const verbs = verbsOf(entry.items)
    const missing = wanted.filter((verb) => !verbs.includes(verb))
    log(
      `${entry.name}: ${missing.length === 0 ? 'has' : `missing ${missing.join(', ')} of`} New ▸, Paste, Display settings, Personalize`
    )
    if (entry.source === 'shell-view' && missing.length > 0) ok = false
  }
  return { ok, runs }
}

function killTree(pid: number | undefined): void {
  if (pid !== undefined)
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

async function partB(dir: string, out: string): Promise<boolean> {
  if (!process.argv.includes('--skip-build') || !existsSync(HELPER)) {
    log('building the app (electron-vite build)…')
    const built = spawnSync('npx electron-vite build', { cwd: ROOT, shell: true, stdio: 'inherit' })
    if (built.status !== 0) return false
  }
  mkdirSync(join(ROOT, 'out', 'spike'), { recursive: true })
  await build({
    entryPoints: [join(ROOT, 'scripts', 'lib', 'spike-shell-menu-electron.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: BUNDLE,
    external: ['electron', 'koffi', 'zod'],
    alias: { '@shared': join(ROOT, 'src', 'shared') },
    logLevel: 'warning'
  })
  const electron = (await import('electron')).default as unknown as string
  log(`running the helper spike in Electron (${electron})`)
  const child = spawn(electron, [BUNDLE], {
    cwd: ROOT,
    env: { ...process.env, SPIKE_HELPER: HELPER, SPIKE_DIR: dir, SPIKE_OUT: out },
    stdio: ['ignore', 'inherit', 'inherit']
  })
  const code = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => {
      log('timed out; killing Electron')
      killTree(child.pid)
      done(null)
    }, ELECTRON_TIMEOUT_MS)
    child.once('exit', (exitCode) => {
      clearTimeout(timer)
      done(exitCode)
    })
  })
  killTree(child.pid)
  const resultFile = join(out, 'result.json')
  if (!existsSync(resultFile)) {
    log(`no result (Electron exit ${code})`)
    return false
  }
  const result = JSON.parse(readFileSync(resultFile, 'utf8')) as Record<string, unknown>
  const summary = { ...result, enumerate: '(see result.json)' }
  console.log(JSON.stringify(summary, null, 2))
  const failures = (result['failures'] as string[] | undefined) ?? ['no failures list']
  for (const failure of failures) log(`FAILED: ${failure}`)
  return code === 0 && failures.length === 0
}

async function main(): Promise<number> {
  if (process.platform !== 'win32') {
    log('Windows only.')
    return 1
  }
  const out = resolve(option('--out') ?? mkdtempSync(join(tmpdir(), 'taskyard-spike-shell-menu-')))
  mkdirSync(out, { recursive: true })
  const dir = mkdtempSync(join(tmpdir(), 'taskyard-spike-temp-'))
  writeFileSync(join(dir, 'a.txt'), 'Taskyard spike file A\n')
  writeFileSync(join(dir, 'b.txt'), 'Taskyard spike file B\n')
  log(`TEMP folder ${dir}; output ${out}`)
  try {
    const a = await partA(dir, out)
    log(
      `Part A ${a.ok ? 'PASS' : 'FAIL'}: shell-view background has New ▸, Paste, Display settings, Personalize`
    )
    if (process.argv.includes('--part-a-only')) return a.ok ? 0 : 1
    const b = await partB(dir, out)
    log(
      `Part B ${b ? 'PASS' : 'FAIL'}: the helper showed, dismissed and invoked (see ${join(out, 'result.json')})`
    )
    return a.ok && b ? 0 : 1
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(error)
    process.exitCode = 1
  }
)
