import { describe, expect, it } from 'vitest'
import { APP_NAME } from '@shared/app-info'
import { placeholderWindowOptions, secureWebPreferences } from './window-options'

const PRELOAD = 'C:\\app\\out\\preload\\index.js'

describe('secureWebPreferences', () => {
  it('isolates and sandboxes the renderer with the given preload', () => {
    expect(secureWebPreferences(PRELOAD)).toEqual({
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    })
  })
})

describe('placeholderWindowOptions', () => {
  it('creates a hidden-until-ready window titled after the app with secure preferences', () => {
    const options = placeholderWindowOptions(PRELOAD)

    expect(APP_NAME).toBe('Taskyard')
    expect(options.title).toBe(APP_NAME)
    expect(options.show).toBe(false)
    expect(options.webPreferences).toEqual(secureWebPreferences(PRELOAD))
  })
})
