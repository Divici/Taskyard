import { describe, expect, it } from 'vitest'
import { readShortcut, type KeyPress } from './shortcut-keys'

const press = (code: string, mods: Partial<KeyPress> = {}, key = ''): KeyPress => ({
  code,
  key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods
})

describe('readShortcut: a key press → an Electron accelerator', () => {
  it('reads modifiers in Electron order, then the key by its physical code', () => {
    expect(readShortcut(press('Space', { ctrlKey: true, altKey: true }))).toEqual({
      kind: 'combo',
      accelerator: 'Ctrl+Alt+Space'
    })
    expect(readShortcut(press('KeyP', { shiftKey: true, ctrlKey: true }))).toEqual({
      kind: 'combo',
      accelerator: 'Ctrl+Shift+P'
    })
    expect(readShortcut(press('Digit7', { metaKey: true, altKey: true }))).toEqual({
      kind: 'combo',
      accelerator: 'Alt+Super+7'
    })
  })

  it('names function, navigation, numpad and punctuation keys the way Electron spells them', () => {
    const combo = (code: string): string | null => {
      const read = readShortcut(press(code, { ctrlKey: true }))
      return read.kind === 'combo' ? read.accelerator : null
    }
    expect(readShortcut(press('F9'))).toEqual({ kind: 'combo', accelerator: 'F9' })
    expect(combo('ArrowUp')).toBe('Ctrl+Up')
    expect(combo('PageDown')).toBe('Ctrl+PageDown')
    expect(combo('Enter')).toBe('Ctrl+Enter')
    expect(combo('Numpad4')).toBe('Ctrl+num4')
    expect(combo('NumpadAdd')).toBe('Ctrl+numadd')
    expect(combo('Minus')).toBe('Ctrl+-')
    expect(combo('BracketLeft')).toBe('Ctrl+[')
    expect(combo('Backquote')).toBe('Ctrl+`')
    expect(combo('Equal')).toBe('Ctrl+=')
  })

  it('a modifier alone keeps recording and shows what is held so far', () => {
    expect(readShortcut(press('ControlLeft', { ctrlKey: true }))).toEqual({
      kind: 'partial',
      held: 'Ctrl+'
    })
    expect(readShortcut(press('AltRight', { ctrlKey: true, altKey: true }))).toEqual({
      kind: 'partial',
      held: 'Ctrl+Alt+'
    })
  })

  it('Esc without modifiers cancels the recording', () => {
    expect(readShortcut(press('Escape'))).toEqual({ kind: 'cancel' })
    expect(readShortcut(press('Escape', { ctrlKey: true }))).toEqual({
      kind: 'combo',
      accelerator: 'Ctrl+Esc'
    })
  })

  it('an unknown key is reported as such', () => {
    expect(readShortcut(press('IntlRo', { ctrlKey: true }))).toEqual({ kind: 'unknown' })
  })
})
