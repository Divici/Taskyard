import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { itemMenuPolicy } from '@shared/shell-menu'
import { realWin32TestsEnabled } from '../test/win32-opt-in'
import { loadWin32Bindings, type Koffi } from '../win32/bindings'
import type { ShellMenuApi, ShellMenuItem, ShellMenuTarget } from '../win32/shell-menu-api'
import { createKoffiShellMenuApi } from '../win32/shell-menu-koffi'
import { FakeHelperChild } from './fake-helper-child'
import { createShellMenuHost, type ShellMenuHost } from './host'

// Opt-in: npm run test:win32. Native menus, Phase 4: the file menu of two TEMP files in one TEMP
// folder, built by the real shell (koffi) behind the helper's request/answer protocol (the real
// host and helper core, in-process). Nothing is shown. Invoking `delete` moves the two TEMP files
// to the Recycle Bin; the test then finds exactly those two there (by the folder they came from)
// and purges them, so nothing is left behind. No other file is touched.

function verbs(items: ShellMenuItem[]): string[] {
  return items.flatMap((item) => [...(item.verb ? [item.verb] : []), ...verbs(item.submenu ?? [])])
}

function labels(items: ShellMenuItem[]): string[] {
  return items.map((item) => (item.separator ? '---' : item.label))
}

/** Runs a PowerShell snippet (no profile) and returns its trimmed standard output. */
function powershell(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  }).trim()
}

/** Recycle Bin entries whose original folder is `dir` (names only). */
function recycledFrom(dir: string): string[] {
  const out = powershell(
    `$bin = (New-Object -ComObject Shell.Application).Namespace(10); ` +
      `$bin.Items() | Where-Object { $_.ExtendedProperty('System.Recycle.DeletedFrom') -eq '${dir}' } | ` +
      `ForEach-Object { $_.Name }`
  )
  return out === '' ? [] : out.split(/\r?\n/).sort()
}

/** Permanently removes the Recycle Bin entries whose original folder is `dir` ($R and $I files). */
function purgeRecycledFrom(dir: string): void {
  powershell(
    `$bin = (New-Object -ComObject Shell.Application).Namespace(10); ` +
      `$bin.Items() | Where-Object { $_.ExtendedProperty('System.Recycle.DeletedFrom') -eq '${dir}' } | ` +
      `ForEach-Object { $r = $_.Path; $i = Join-Path (Split-Path $r) ('$I' + (Split-Path $r -Leaf).Substring(2)); ` +
      `Remove-Item -LiteralPath $r -Force -Recurse; Remove-Item -LiteralPath $i -Force -ErrorAction SilentlyContinue }`
  )
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return check()
}

describe.runIf(realWin32TestsEnabled())('icon file menus through the helper (real shell32)', () => {
  let koffi: Koffi
  let api: ShellMenuApi
  let host: ShellMenuHost
  let dir: string
  let target: ShellMenuTarget

  beforeAll(async () => {
    koffi = (await import('koffi')).default
    loadWin32Bindings(koffi)
    api = createKoffiShellMenuApi(koffi)
    host = createShellMenuHost({
      fork: () => new FakeHelperChild({ api }),
      allowForeground: () => {},
      log: { info: () => {}, warn: () => {}, error: () => {} }
    })
    dir = mkdtempSync(join(tmpdir(), 'taskyard-item-menu-'))
    const a = join(dir, 'first.txt')
    const b = join(dir, 'second.txt')
    writeFileSync(a, 'first')
    writeFileSync(b, 'second')
    target = { kind: 'items', paths: [a, b] }
  })

  afterAll(() => {
    host?.dispose()
    api?.dispose()
    if (dir) {
      purgeRecycledFrom(dir)
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('builds one menu for two files in one folder with Delete, Copy and Properties', async () => {
    const items = await host.enumerate(target)
    expect(verbs(items)).toEqual(expect.arrayContaining(['delete', 'copy', 'properties']))
  })

  it('shapes it with the icon policy: Remove from group on top, Rename hidden, Copy path only without Copy as path', () => {
    const shell = verbs(api.enumerate(target, { extendedVerbs: false }))
    const menu = api.preview({
      target,
      point: { x: 0, y: 0 },
      extendedVerbs: false,
      ...itemMenuPolicy({ inGroup: true, canRename: false })
    })
    const windowsCopiesPaths = shell.includes('copyaspath')
    expect(labels(menu).slice(0, windowsCopiesPaths ? 2 : 3)).toEqual(
      windowsCopiesPaths ? ['Remove from group', '---'] : ['Remove from group', 'Copy path', '---']
    )
    expect(verbs(menu)).not.toContain('rename')
    expect(verbs(menu)).toEqual(expect.arrayContaining(['delete', 'copy', 'properties']))
  })

  it('invoking delete through the helper sends both files to the Recycle Bin', async () => {
    await host.invokeVerb(target, 'delete')
    const paths = target.kind === 'items' ? target.paths : []
    const gone = await until(() => paths.every((path) => !existsSync(path)), 15_000)
    expect(gone).toBe(true)
    expect(await until(() => recycledFrom(dir).length === 2, 10_000)).toBe(true)
    // Names as the shell shows them (with or without the extension, per Explorer's setting).
    expect(recycledFrom(dir).map((name) => name.replace(/\.txt$/, ''))).toEqual(['first', 'second'])
  })
})
