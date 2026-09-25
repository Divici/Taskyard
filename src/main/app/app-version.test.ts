import { describe, expect, it } from 'vitest'
import { version } from '../../../package.json'
import { appVersion } from './app-version'

describe('appVersion', () => {
  it('is what Electron says in the packaged app', () => {
    expect(appVersion({ isPackaged: true, getVersion: () => '1.2.3' })).toBe('1.2.3')
  })

  it('is package.json’s version when main runs as a bare script (Electron would say its own)', () => {
    expect(appVersion({ isPackaged: false, getVersion: () => '44.4.5' })).toBe(version)
  })
})
