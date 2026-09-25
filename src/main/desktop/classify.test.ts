import { describe, expect, it } from 'vitest'
import { classifyItem, isPartialName, isShortcutKind } from './classify'

describe('classifyItem', () => {
  it('folders are folders, whatever their name', () => {
    expect(classifyItem('Projects', true)).toBe('folder')
    expect(classifyItem('Backup.lnk', true)).toBe('folder')
  })

  it('.lnk → link, .url → url (any case)', () => {
    expect(classifyItem('Steam.lnk', false)).toBe('link')
    expect(classifyItem('Docs.URL', false)).toBe('url')
  })

  it('programs and installers → app', () => {
    for (const name of [
      'setup.exe',
      'App.MSI',
      'build.bat',
      'run.cmd',
      'old.com',
      'Tool.appref-ms'
    ]) {
      expect(classifyItem(name, false), name).toBe('app')
    }
  })

  it('everything else → file', () => {
    for (const name of ['report.pdf', 'photo.png', 'README', '.gitignore', 'archive.lnk.txt']) {
      expect(classifyItem(name, false), name).toBe('file')
    }
  })

  it('knows which kinds are shortcuts', () => {
    expect(isShortcutKind('link')).toBe(true)
    expect(isShortcutKind('url')).toBe(true)
    expect(isShortcutKind('app')).toBe(false)
  })
})

describe('isPartialName', () => {
  it('matches only the temporary names of an unfinished move', () => {
    expect(isPartialName('.taskyard-5f0c7a4e-1b2c-4d3e-8f90-123456789abc.partial')).toBe(true)
    expect(isPartialName('.TASKYARD-abc.PARTIAL')).toBe(true)
    expect(isPartialName('taskyard-abc.partial')).toBe(false)
    expect(isPartialName('.taskyard-abc.partial.txt')).toBe(false)
    expect(isPartialName('report.partial')).toBe(false)
  })
})
