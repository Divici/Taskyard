import { describe, expect, it } from 'vitest'
import { secureWebPreferences } from './window-options'

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
