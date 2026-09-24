import { describe, expect, it } from 'vitest'
import { parseEnvironmentBlock } from './env-block'

describe('parseEnvironmentBlock', () => {
  it('splits a NUL-separated, double-NUL-terminated block into variables', () => {
    const block = 'Path=C:\\Windows;C:\\Tools\0USERPROFILE=C:\\Users\\me\0\0'

    expect(parseEnvironmentBlock(block)).toEqual({
      Path: 'C:\\Windows;C:\\Tools',
      USERPROFILE: 'C:\\Users\\me'
    })
  })

  it('keeps "=" inside values and skips per-drive "=C:" entries', () => {
    const block = '=C:=C:\\work\0OPTS=a=b\0\0'

    expect(parseEnvironmentBlock(block)).toEqual({ OPTS: 'a=b' })
  })

  it('stops at the terminating empty entry', () => {
    expect(parseEnvironmentBlock('A=1\0\0B=2\0\0')).toEqual({ A: '1' })
  })

  it('returns an empty object for an empty block', () => {
    expect(parseEnvironmentBlock('\0\0')).toEqual({})
  })
})
