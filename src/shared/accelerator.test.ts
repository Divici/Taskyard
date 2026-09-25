import { describe, expect, it } from 'vitest'
import { normalizeAccelerator } from './accelerator'

describe('normalizeAccelerator (Peek shortcut validation)', () => {
  it('accepts the default and writes modifiers and keys in canonical form', () => {
    expect(normalizeAccelerator('Ctrl+Alt+Space')).toBe('Ctrl+Alt+Space')
    expect(normalizeAccelerator(' control + alt + space ')).toBe('Ctrl+Alt+Space')
    expect(normalizeAccelerator('ctrl+shift+p')).toBe('Ctrl+Shift+P')
    expect(normalizeAccelerator('Super+F9')).toBe('Super+F9')
    expect(normalizeAccelerator('CmdOrCtrl+Alt+PageDown')).toBe('CommandOrControl+Alt+PageDown')
    expect(normalizeAccelerator('Alt+Plus')).toBe('Alt+Plus')
    expect(normalizeAccelerator('Ctrl+Alt+num5')).toBe('Ctrl+Alt+num5')
  })

  it('accepts a bare function key (nothing else is safe without a modifier)', () => {
    expect(normalizeAccelerator('F13')).toBe('F13')
    expect(normalizeAccelerator('Space')).toBeNull()
    expect(normalizeAccelerator('A')).toBeNull()
    expect(normalizeAccelerator('Shift+A')).toBeNull()
  })

  it('rejects anything Electron would refuse or misread', () => {
    for (const bad of [
      '',
      '   ',
      'Ctrl+Alt',
      'Ctrl+Alt+',
      '+Space',
      'Ctrl++Space',
      'Ctrl+Ctrl+Space',
      'Ctrl+Space+Alt',
      'Ctrl+A+B',
      'Ctrl+Alt+Spacebar',
      'Ctrl+Alt+F25',
      'Hyper+Space',
      'Ctrl+Alt+Space'.repeat(10)
    ]) {
      expect(normalizeAccelerator(bad), bad).toBeNull()
    }
  })
})
