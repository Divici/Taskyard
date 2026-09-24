import { describe, expect, it } from 'vitest'
import { baseName, splitItemName } from './item-name'

describe('baseName', () => {
  it.each([
    ['C:\\Users\\me\\Desktop\\Notes.txt', 'Notes.txt'],
    ['C:/Users/me/Desktop/Notes.txt', 'Notes.txt'],
    ['\\\\server\\share\\Report.pdf', 'Report.pdf'],
    ['C:\\Users\\me\\Desktop\\Folder\\', 'Folder'],
    ['Notes.txt', 'Notes.txt']
  ])('%s → %s', (path, expected) => {
    expect(baseName(path)).toBe(expected)
  })
})

describe('splitItemName', () => {
  it('splits a file at its last dot, keeping the extension as written', () => {
    expect(splitItemName('C:\\Desktop\\report.final.PDF', 'file')).toEqual({
      name: 'report.final',
      ext: '.PDF'
    })
  })

  it('keeps a shortcut extension separate so the UI can hide it', () => {
    expect(splitItemName('C:\\Desktop\\Visual Studio Code.lnk', 'link')).toEqual({
      name: 'Visual Studio Code',
      ext: '.lnk'
    })
  })

  it('never splits a folder name', () => {
    expect(splitItemName('C:\\Desktop\\photos.2024', 'folder')).toEqual({
      name: 'photos.2024',
      ext: ''
    })
  })

  it('treats a leading dot as part of the name', () => {
    expect(splitItemName('C:\\Desktop\\.gitignore', 'file')).toEqual({
      name: '.gitignore',
      ext: ''
    })
  })

  it('handles a name without an extension', () => {
    expect(splitItemName('C:\\Desktop\\README', 'file')).toEqual({ name: 'README', ext: '' })
  })
})
