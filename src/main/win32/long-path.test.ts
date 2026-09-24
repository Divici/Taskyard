import { describe, expect, it } from 'vitest'
import { toExtendedLengthPath } from './long-path'

describe('toExtendedLengthPath', () => {
  it('prefixes a drive path with \\\\?\\', () => {
    expect(toExtendedLengthPath('C:\\Users\\me\\Desktop\\a.lnk')).toBe(
      '\\\\?\\C:\\Users\\me\\Desktop\\a.lnk'
    )
  })

  it('normalizes separators, dot segments and trailing slashes first (\\\\?\\ disables that)', () => {
    expect(toExtendedLengthPath('C:/Users/me/./Desktop/../Desktop/notes.txt')).toBe(
      '\\\\?\\C:\\Users\\me\\Desktop\\notes.txt'
    )
    expect(toExtendedLengthPath('D:\\data\\')).toBe('\\\\?\\D:\\data')
    expect(toExtendedLengthPath('D:\\')).toBe('\\\\?\\D:\\')
  })

  it('rewrites a UNC path to \\\\?\\UNC\\', () => {
    expect(toExtendedLengthPath('\\\\server\\share\\dir\\file.txt')).toBe(
      '\\\\?\\UNC\\server\\share\\dir\\file.txt'
    )
  })

  it('leaves an already extended or device path alone', () => {
    expect(toExtendedLengthPath('\\\\?\\C:\\x')).toBe('\\\\?\\C:\\x')
    expect(toExtendedLengthPath('\\\\?\\UNC\\server\\share')).toBe('\\\\?\\UNC\\server\\share')
    expect(toExtendedLengthPath('\\\\.\\PhysicalDrive0')).toBe('\\\\.\\PhysicalDrive0')
  })

  it('keeps paths longer than MAX_PATH intact', () => {
    const deep = `C:\\${'d'.repeat(120)}\\${'e'.repeat(120)}\\${'f'.repeat(120)}.txt`
    expect(toExtendedLengthPath(deep)).toBe(`\\\\?\\${deep}`)
  })
})
