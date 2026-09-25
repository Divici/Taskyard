import { describe, expect, it } from 'vitest'
import type { DesktopItem } from '@shared/schema'
import { BASE_ICON_PX, iconPx, planIcon, systemFolderIcon } from './icon-plan'

const SYSTEM_ROOT = 'C:\\Windows'
const FOLDER_ICON = systemFolderIcon(SYSTEM_ROOT)

function item(fields: Partial<DesktopItem>): DesktopItem {
  return {
    id: '1:2',
    path: 'C:\\Users\\me\\Desktop\\Thing',
    name: 'Thing',
    ext: '',
    kind: 'file',
    mtimeMs: 1,
    sizeBytes: 1,
    readonly: false,
    placeholder: false,
    ...fields
  }
}

const plan = (fields: Partial<DesktopItem>): ReturnType<typeof planIcon> =>
  planIcon(item(fields), SYSTEM_ROOT)

describe('iconPx', () => {
  it('is 64 × the largest scale factor over all displays, rounded up', () => {
    expect(iconPx([1])).toBe(64)
    expect(iconPx([1, 1.5])).toBe(96)
    expect(iconPx([1.25])).toBe(80)
    expect(iconPx([1.75, 1])).toBe(112)
    expect(iconPx([2])).toBe(128)
  })

  it('never goes below 64 (no displays, or a bogus factor)', () => {
    expect(iconPx([])).toBe(64)
    expect(iconPx([0.5])).toBe(64)
  })

  it('starts from Electron’s 32 px icon', () => {
    expect(BASE_ICON_PX).toBe(32)
  })
})

describe('planIcon', () => {
  it('never touches a placeholder (cloud file), whatever its kind', () => {
    for (const kind of ['app', 'file', 'folder', 'link', 'url'] as const) {
      expect(plan({ kind, placeholder: true, targetPath: 'C:\\x.exe' })).toEqual({
        kind: 'generic',
        reason: 'placeholder'
      })
    }
  })

  it('never touches a shortcut to a network target', () => {
    expect(
      plan({
        kind: 'link',
        ext: '.lnk',
        targetPath: '\\\\server\\share\\app.exe',
        targetRemote: true
      })
    ).toEqual({ kind: 'generic', reason: 'remote' })
  })

  it('app (.exe): Electron’s 32 px from the file, then its first icon at the display size', () => {
    const path = 'C:\\Users\\me\\Desktop\\tool.exe'
    expect(plan({ kind: 'app', ext: '.exe', path })).toEqual({
      kind: 'local',
      base: path,
      upgrade: { file: path, index: 0 },
      folderCheck: null
    })
  })

  it('app without icon resources (.bat, .msi): Electron’s 32 px only', () => {
    const path = 'C:\\Users\\me\\Desktop\\run.bat'
    expect(plan({ kind: 'app', ext: '.bat', path })).toEqual({
      kind: 'local',
      base: path,
      upgrade: null,
      folderCheck: null
    })
  })

  it('document: Electron’s 32 px (by extension; the file is not opened)', () => {
    const path = 'C:\\Users\\me\\Desktop\\notes.txt'
    expect(plan({ kind: 'file', ext: '.txt', path })).toEqual({
      kind: 'local',
      base: path,
      upgrade: null,
      folderCheck: null
    })
  })

  it('folder: the Windows folder icon from imageres.dll (Electron’s would be a drive)', () => {
    expect(plan({ kind: 'folder' })).toEqual({
      kind: 'local',
      base: null,
      upgrade: FOLDER_ICON,
      folderCheck: null
    })
    expect(FOLDER_ICON).toEqual({ file: 'C:\\Windows\\System32\\imageres.dll', index: -3 })
  })

  it('.lnk to a local .exe: the target’s icon (never the .lnk’s own, which Electron draws blank)', () => {
    const target = 'C:\\Program Files\\App\\app.exe'
    expect(plan({ kind: 'link', ext: '.lnk', targetPath: target, targetRemote: false })).toEqual({
      kind: 'local',
      base: target,
      upgrade: { file: target, index: 0 },
      folderCheck: null
    })
  })

  it('.lnk with an IconLocation: that icon, at its index', () => {
    const target = 'C:\\Users\\me\\AppData\\Local\\Discord\\Update.exe'
    const icon = 'C:\\Users\\me\\AppData\\Local\\Discord\\app.ico'
    expect(
      plan({ kind: 'link', ext: '.lnk', targetPath: target, iconPath: icon, iconIndex: 0 })
    ).toEqual({ kind: 'local', base: icon, upgrade: { file: icon, index: 0 }, folderCheck: null })

    const dll = 'C:\\Windows\\System32\\shell32.dll'
    expect(
      plan({ kind: 'link', ext: '.lnk', targetPath: target, iconPath: dll, iconIndex: -16 })
    ).toEqual({
      kind: 'local',
      // Electron cannot pick an index: its 32 px comes from the target instead.
      base: target,
      upgrade: { file: dll, index: -16 },
      folderCheck: null
    })
  })

  it('.lnk to a document: the document type’s 32 px icon', () => {
    const target = 'D:\\Docs\\report.pdf'
    expect(plan({ kind: 'link', ext: '.lnk', targetPath: target })).toEqual({
      kind: 'local',
      base: target,
      upgrade: null,
      folderCheck: null
    })
  })

  it('.lnk to a path without an extension: decided by a stat (a folder gets the folder icon)', () => {
    const target = 'D:\\Desktop Backup\\Misc'
    expect(plan({ kind: 'link', ext: '.lnk', targetPath: target })).toEqual({
      kind: 'local',
      base: null,
      upgrade: null,
      folderCheck: target
    })
  })

  it('.lnk whose IconLocation is on the network: the target’s icon, the network one never', () => {
    const target = 'C:\\Program Files\\App\\app.exe'
    expect(
      plan({ kind: 'link', ext: '.lnk', targetPath: target, iconPath: '\\\\srv\\icons\\a.ico' })
    ).toEqual({
      kind: 'local',
      base: target,
      upgrade: { file: target, index: 0 },
      folderCheck: null
    })
  })

  it('.lnk without a target path (IDList only): its IconLocation, else the generic icon', () => {
    const icon = 'C:\\Program Files\\Epic\\launcher.exe'
    expect(plan({ kind: 'link', ext: '.lnk', iconPath: icon, iconIndex: 0 })).toEqual({
      kind: 'local',
      base: icon,
      upgrade: { file: icon, index: 0 },
      folderCheck: null
    })
    expect(plan({ kind: 'link', ext: '.lnk' })).toEqual({ kind: 'generic', reason: 'no-source' })
  })

  it('.url with a local IconFile: that icon; without one, Electron’s .url icon', () => {
    const path = 'C:\\Users\\me\\Desktop\\Game.url'
    const ico = 'D:\\Games\\Steam\\steam\\games\\abc.ico'
    expect(plan({ kind: 'url', ext: '.url', path, iconPath: ico, iconIndex: 0 })).toEqual({
      kind: 'local',
      base: ico,
      upgrade: { file: ico, index: 0 },
      folderCheck: null
    })
    expect(plan({ kind: 'url', ext: '.url', path })).toEqual({
      kind: 'local',
      base: path,
      upgrade: null,
      folderCheck: null
    })
    expect(
      plan({ kind: 'url', ext: '.url', path, iconPath: 'https://example.com/favicon.ico' })
    ).toEqual({ kind: 'local', base: path, upgrade: null, folderCheck: null })
  })
})

describe('planIcon: mapped network drives (review fix)', () => {
  // Z: is a mapped network drive; C: and D: are local.
  const isRemoteDrive = (path: string): boolean => /^z:/i.test(path)
  const planOn = (fields: Partial<DesktopItem>): ReturnType<typeof planIcon> =>
    planIcon(item(fields), SYSTEM_ROOT, isRemoteDrive)

  it('a shortcut whose target is on a mapped network drive is generic (never read)', () => {
    expect(planOn({ kind: 'link', ext: '.lnk', targetPath: 'Z:\\apps\\tool.exe' })).toEqual({
      kind: 'generic',
      reason: 'remote'
    })
    expect(planOn({ kind: 'link', ext: '.lnk', targetPath: 'Z:\\Folder' })).toEqual({
      kind: 'generic',
      reason: 'remote'
    })
  })

  it('an IconLocation on a mapped network drive is ignored: the local target is used', () => {
    const target = 'C:\\Program Files\\App\\app.exe'
    expect(
      planOn({ kind: 'link', ext: '.lnk', targetPath: target, iconPath: 'Z:\\icons\\a.ico' })
    ).toEqual({
      kind: 'local',
      base: target,
      upgrade: { file: target, index: 0 },
      folderCheck: null
    })
    expect(planOn({ kind: 'link', ext: '.lnk', iconPath: 'Z:\\icons\\a.ico' })).toEqual({
      kind: 'generic',
      reason: 'no-source'
    })
  })

  it('a .url IconFile on a mapped network drive is ignored: Electron’s .url icon instead', () => {
    const path = 'C:\\Users\\me\\Desktop\\Game.url'
    expect(
      planOn({ kind: 'url', ext: '.url', path, iconPath: 'Z:\\games\\a.ico', iconIndex: 0 })
    ).toEqual({ kind: 'local', base: path, upgrade: null, folderCheck: null })
  })

  it('local drives are unaffected', () => {
    const target = 'D:\\Games\\Steam\\Steam.exe'
    expect(planOn({ kind: 'link', ext: '.lnk', targetPath: target })).toEqual({
      kind: 'local',
      base: target,
      upgrade: { file: target, index: 0 },
      folderCheck: null
    })
  })
})
