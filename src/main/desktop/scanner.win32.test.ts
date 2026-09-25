import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { realWin32TestsEnabled } from '../test/win32-opt-in'
import type { Win32Api } from '../win32/api'
import type { Koffi } from '../win32/bindings'
import { createKoffiWin32Api } from '../win32/koffi-api'
import { parseLnk, resolveLnk } from './lnk-parser'
import { scanDesktop } from './scanner'
import { readShortcut } from './shortcuts'
import { buildBenchDesktop, BENCH_COUNTS } from './test/fixtures'
import { writeLnk } from './test/lnk-writer'

/** Runs PowerShell with the script on stdin; returns trimmed stdout. */
function powershell(script: string): string {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    input: script,
    encoding: 'utf8'
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

// Opt-in: npm run test:win32. Temp folders only; nothing on the real desktop is touched.
describe.runIf(realWin32TestsEnabled())('desktop scanner and .lnk parser (real Win32)', () => {
  let api: Win32Api
  let dir: string

  beforeAll(async () => {
    const koffi = (await import('koffi')).default as Koffi
    api = createKoffiWin32Api(koffi, { log: { warn: vi.fn(), error: vi.fn() } })
    dir = buildBenchDesktop()
  })

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('scans the 200-item bench desktop with real attributes in ≤ 300 ms, skipping a hidden file', async () => {
    writeFileSync(join(dir, 'desktop.ini'), '[.ShellClassInfo]')
    spawnSync('attrib', ['+h', '+s', join(dir, 'desktop.ini')])
    const log = { info: vi.fn(), warn: vi.fn() }

    const report = await scanDesktop([dir], {
      win32: api,
      readShortcut: (path, kind) => readShortcut(path, kind, { readFile, env: process.env, log }),
      log
    })

    expect(report.items).toHaveLength(BENCH_COUNTS.total)
    expect(report.folders[0].readonly).toBe(false)
    expect(report.ms).toBeLessThanOrEqual(300)
  })

  it('Windows reads a .lnk our writer produced: target, name and icon block (WScript.Shell)', () => {
    // IShellLink answers TargetPath from the IDList (a LinkInfo-only link reads as ''), so the
    // IDList items come from a link Windows wrote for the same target; header, LinkInfo,
    // StringData, ExtraData and the terminal block are ours.
    const reference = join(dir, 'reference.lnk')
    powershell(
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${reference}')\n` +
        `$s.TargetPath = 'C:\\Windows\\System32\\notepad.exe'\n$s.Save()`
    )
    const bytes = readFileSync(reference)
    const items: Buffer[] = []
    const end = 78 + bytes.readUInt16LE(76)
    for (let at = 78; at < end;) {
      const size = bytes.readUInt16LE(at)
      if (size === 0) break
      items.push(Buffer.from(bytes.subarray(at + 2, at + size)))
      at += size
    }
    const lnk = join(dir, 'written-by-taskyard.lnk')
    writeFileSync(
      lnk,
      writeLnk({
        idList: items,
        localBasePath: 'C:\\Windows\\System32\\notepad.exe',
        name: 'Notes',
        envIcon: '%SystemRoot%\\notepad.exe',
        iconIndex: 0
      })
    )

    const [target, description, icon] = powershell(
      `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}')\n` +
        '$s.TargetPath\n$s.Description\n$s.IconLocation'
    ).split(/\r?\n/)

    expect(target.toLowerCase()).toBe('c:\\windows\\system32\\notepad.exe')
    expect(description).toBe('Notes')
    expect(icon.toLowerCase()).toBe('c:\\windows\\notepad.exe,0')
  })

  it('our parser reads a shortcut Windows wrote (WScript.Shell), including its icon', () => {
    const lnk = join(dir, 'written-by-windows.lnk')
    powershell(
      [
        `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}')`,
        `$s.TargetPath = 'C:\\Windows\\System32\\notepad.exe'`,
        `$s.IconLocation = 'C:\\Windows\\System32\\shell32.dll,4'`,
        `$s.WorkingDirectory = 'C:\\Windows'`,
        '$s.Save()'
      ].join('\n')
    )

    const info = parseLnk(readFileSync(lnk))
    const resolved = resolveLnk(info, { lnkDir: dir, env: process.env })

    expect(resolved.targetPath?.toLowerCase()).toBe('c:\\windows\\system32\\notepad.exe')
    expect(resolved).toMatchObject({ targetRemote: false, local: true, iconIndex: 4 })
    expect(resolved.iconPath?.toLowerCase()).toBe('c:\\windows\\system32\\shell32.dll')
    expect(info.workingDir).toBe('C:\\Windows')
  })
})
