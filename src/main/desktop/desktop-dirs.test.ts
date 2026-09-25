import { describe, expect, it } from 'vitest'
import { publicDesktopDir, resolveDesktopDirs } from './desktop-dirs'

const USER = 'C:\\Users\\me\\Desktop'

describe('resolveDesktopDirs', () => {
  it('scans the user Desktop first, then the Public Desktop', () => {
    expect(resolveDesktopDirs({ env: { PUBLIC: 'C:\\Users\\Public' }, userDesktop: USER })).toEqual(
      [USER, 'C:\\Users\\Public\\Desktop']
    )
  })

  it('falls back to C:\\Users\\Public\\Desktop without %PUBLIC%', () => {
    expect(publicDesktopDir({})).toBe('C:\\Users\\Public\\Desktop')
    expect(publicDesktopDir({ PUBLIC: 'D:\\Shared' })).toBe('D:\\Shared\\Desktop')
  })

  it('TASKYARD_DESKTOP_DIRS (semicolon list) replaces both; the first entry is the user desktop', () => {
    expect(
      resolveDesktopDirs({
        env: { TASKYARD_DESKTOP_DIRS: ' C:\\tmp\\a ; ;C:\\tmp\\b\\ ', PUBLIC: 'C:\\Users\\Public' },
        userDesktop: USER
      })
    ).toEqual(['C:\\tmp\\a', 'C:\\tmp\\b'])
  })

  it('drops duplicates case-insensitively (a Desktop redirected onto the Public one)', () => {
    expect(
      resolveDesktopDirs({
        env: { PUBLIC: 'C:\\Users\\Public' },
        userDesktop: 'c:\\users\\public\\desktop'
      })
    ).toEqual(['c:\\users\\public\\desktop'])
  })

  it('ignores an override that lists nothing', () => {
    expect(
      resolveDesktopDirs({
        env: { TASKYARD_DESKTOP_DIRS: ' ; ', PUBLIC: 'D:\\Shared' },
        userDesktop: USER
      })
    ).toEqual([USER, 'D:\\Shared\\Desktop'])
  })
})
