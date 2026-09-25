import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { driveItem, fileItem, rootItem, writeLnk } from './lnk-writer'

const MY_COMPUTER = '{20D04FE0-3AEA-1069-A2D8-08002B30309D}'

/** The bench desktop: 200 items, 150 of them `.lnk` (this machine is 77 % shortcuts). */
export const BENCH_COUNTS = { links: 150, urls: 20, files: 15, folders: 10, apps: 5, total: 200 }

/**
 * A shortcut shaped like the ones Windows writes: IDList, LinkInfo, relative path, working
 * directory, icon location and a property-store-sized extra block (~1.4 KB in all).
 */
export function realisticLnk(index: number): Buffer {
  const target = `C:\\Program Files\\Vendor ${index}\\App ${index}\\app${index}.exe`
  return writeLnk({
    idList: [
      rootItem(MY_COMPUTER),
      driveItem('C:\\'),
      fileItem('Program Files'),
      fileItem(`app${index}.exe`)
    ],
    localBasePath: target,
    relativePath: `..\\..\\..\\..\\Program Files\\Vendor ${index}\\App ${index}\\app${index}.exe`,
    workingDir: `C:\\Program Files\\Vendor ${index}\\App ${index}`,
    iconLocation: `C:\\Program Files\\Vendor ${index}\\App ${index}\\app${index}.exe`,
    iconIndex: 0,
    paddingBytes: 700
  })
}

/** Writes the 200-item bench desktop into a new temp folder and returns its path. */
export function buildBenchDesktop(): string {
  const dir = mkdtempSync(join(tmpdir(), 'taskyard-bench-desktop-'))
  for (let i = 0; i < BENCH_COUNTS.links; i++) {
    writeFileSync(join(dir, `App ${i}.lnk`), realisticLnk(i))
  }
  for (let i = 0; i < BENCH_COUNTS.urls; i++) {
    writeFileSync(
      join(dir, `Site ${i}.url`),
      `[InternetShortcut]\r\nURL=https://example.com/${i}\r\nIconIndex=0\r\n`
    )
  }
  for (let i = 0; i < BENCH_COUNTS.files; i++) {
    writeFileSync(join(dir, `Document ${i}.txt`), `document ${i}\n`)
  }
  for (let i = 0; i < BENCH_COUNTS.folders; i++) {
    mkdirSync(join(dir, `Folder ${i}`))
  }
  for (let i = 0; i < BENCH_COUNTS.apps; i++) {
    writeFileSync(join(dir, `tool${i}.exe`), 'MZ')
  }
  return dir
}
