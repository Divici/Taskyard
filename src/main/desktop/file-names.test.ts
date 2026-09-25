import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  freeName,
  isVolumeOrShareRoot,
  MAX_NAME_LENGTH,
  suffixedName,
  validateFileName
} from './file-names'

describe('validateFileName', () => {
  it('accepts ordinary names, including dots, spaces inside and Unicode', () => {
    for (const name of [
      'a.txt',
      'Quarterly report.final.pdf',
      'Ünïcödé 📁',
      '.gitignore',
      'x'.repeat(255)
    ]) {
      expect(validateFileName(name), name).toBeNull()
    }
  })

  it('rejects empty names and the characters Windows forbids', () => {
    expect(validateFileName('')).toBe('invalid-name')
    expect(validateFileName('   ')).toBe('invalid-name')
    for (const char of ['<', '>', ':', '"', '/', '\\', '|', '?', '*', '\u0001', '\u001f']) {
      expect(validateFileName(`a${char}b.txt`), JSON.stringify(char)).toBe('invalid-name')
    }
  })

  it('rejects reserved device names (with or without an extension) and "." / ".."', () => {
    for (const name of [
      'CON',
      'prn.txt',
      'Aux',
      'NUL.tar.gz',
      'COM1',
      'lpt9.log',
      'COM¹',
      '.',
      '..'
    ]) {
      expect(validateFileName(name), name).toBe('invalid-name')
    }
    expect(validateFileName('CONSOLE.txt')).toBeNull()
  })

  it('rejects a trailing dot or space (Explorer could not open the file)', () => {
    expect(validateFileName('a.txt.')).toBe('invalid-name')
    expect(validateFileName('a.txt ')).toBe('invalid-name')
  })

  it(`rejects names longer than ${MAX_NAME_LENGTH} characters`, () => {
    expect(validateFileName('x'.repeat(256))).toBe('name-too-long')
  })
})

describe('isVolumeOrShareRoot', () => {
  it('recognises drive roots and UNC share roots in every spelling', () => {
    for (const root of [
      'D:\\',
      'd:',
      'C:\\\\',
      '\\\\server\\share',
      '\\\\server\\share\\',
      '\\\\?\\D:\\',
      '\\\\?\\UNC\\server\\share'
    ]) {
      expect(isVolumeOrShareRoot(root), root).toBe(true)
    }
  })

  it('leaves ordinary files and folders alone', () => {
    for (const path of ['D:\\a.txt', 'D:\\Photos\\', '\\\\server\\share\\folder', 'C:\\Users']) {
      expect(isVolumeOrShareRoot(path), path).toBe(false)
    }
  })
})

describe('suffixedName', () => {
  it('adds a Windows-style " (n)" before the extension; folders have none', () => {
    expect(suffixedName('report.pdf', 2, false)).toBe('report (2).pdf')
    expect(suffixedName('archive.tar.gz', 3, false)).toBe('archive.tar (3).gz')
    expect(suffixedName('.gitignore', 2, false)).toBe('.gitignore (2)')
    expect(suffixedName('Stuff.2024', 2, true)).toBe('Stuff.2024 (2)')
  })
})

describe('freeName', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'taskyard-names-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps the name when it is free', async () => {
    expect(await freeName(dir, 'a.txt', false)).toBe(join(dir, 'a.txt'))
  })

  it('counts up past every taken name, comparing case-insensitively like NTFS', async () => {
    writeFileSync(join(dir, 'A.TXT'), '')
    writeFileSync(join(dir, 'a (2).txt'), '')
    mkdirSync(join(dir, 'A (3).txt'))

    expect(await freeName(dir, 'a.txt', false)).toBe(join(dir, 'a (4).txt'))
  })

  it('suffixes folders without splitting their name', async () => {
    mkdirSync(join(dir, 'Photos.2024'))

    expect(await freeName(dir, 'Photos.2024', true)).toBe(join(dir, 'Photos.2024 (2)'))
  })
})
