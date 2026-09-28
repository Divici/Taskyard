import { describe, expect, it } from 'vitest'
import { isContextMenuKey } from './context-menu-key'

describe('isContextMenuKey', () => {
  it('Shift+F10 and the menu key; plain F10 is not', () => {
    expect(isContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true)
    expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true)
    expect(isContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false)
    expect(isContextMenuKey({ key: 'Enter', shiftKey: true })).toBe(false)
  })
})
