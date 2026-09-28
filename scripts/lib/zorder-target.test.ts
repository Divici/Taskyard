import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACKAGED_EXE, zorderTarget } from './zorder-target'

const ROOT = String.raw`C:\repo`
const DEV = {
  electron: String.raw`C:\repo\node_modules\electron\dist\electron.exe`,
  main: String.raw`C:\repo\out\main\index.js`
}

describe('zorderTarget', () => {
  it('by default runs the dev build (electron.exe out/main) and builds it first', () => {
    expect(zorderTarget([], ROOT, DEV)).toEqual({
      kind: 'dev',
      command: DEV.electron,
      args: [DEV.main],
      build: true,
      label: DEV.main
    })
    expect(zorderTarget(['--no-build'], ROOT, DEV)).toMatchObject({ kind: 'dev', build: false })
  })

  it('--packaged runs dist/win-unpacked/Taskyard.exe, with no build', () => {
    const exe = join(ROOT, PACKAGED_EXE)
    expect(zorderTarget(['--packaged'], ROOT, DEV)).toEqual({
      kind: 'packaged',
      command: exe,
      args: [],
      build: false,
      label: exe
    })
  })

  it('--exe <path> runs that exe (e.g. the installed copy)', () => {
    const exe = String.raw`C:\Users\me\AppData\Local\Programs\Taskyard\Taskyard.exe`
    expect(zorderTarget(['--exe', exe], ROOT, DEV)).toMatchObject({
      kind: 'packaged',
      command: exe,
      args: [],
      build: false
    })
    expect(() => zorderTarget(['--exe'], ROOT, DEV)).toThrow(/--exe needs a path/)
  })
})
