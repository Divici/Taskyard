import { describe, expect, it } from 'vitest'
import { explorerKillArgs, explorerListArgs } from './explorer'

describe('explorer command lines', () => {
  it('kills only the explorer.exe of the current session', () => {
    expect(explorerKillArgs(3)).toEqual(['/f', '/fi', 'SESSION eq 3', '/im', 'explorer.exe'])
  })

  it('lists only the explorer.exe of the current session', () => {
    expect(explorerListArgs(3)).toEqual([
      '/fi',
      'IMAGENAME eq explorer.exe',
      '/fi',
      'SESSION eq 3',
      '/nh',
      '/fo',
      'csv'
    ])
  })
})
