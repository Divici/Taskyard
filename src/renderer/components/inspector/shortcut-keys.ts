// The Peek shortcut recorder's key reading: a keydown → an Electron accelerator string. Keys are
// read by their physical `code` (the same key whatever the keyboard layout or held modifiers
// produce as a character), which is what a global shortcut binds. Validity (e.g. "needs Ctrl,
// Alt or Win") is judged afterwards by the shared `normalizeAccelerator`, exactly as main does.

export interface KeyPress {
  code: string
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export type ShortcutRead =
  /** A full shortcut: modifiers (maybe none) and one key. */
  | { kind: 'combo'; accelerator: string }
  /** Only modifiers so far ("Ctrl+Alt+"): keep listening. */
  | { kind: 'partial'; held: string }
  /** Esc on its own: stop recording, keep the current shortcut. */
  | { kind: 'cancel' }
  /** A key Electron has no name for. */
  | { kind: 'unknown' }

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight'
])

const NAMED: Readonly<Record<string, string>> = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  PrintScreen: 'PrintScreen',
  NumpadDecimal: 'numdec',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]
  const numpad = /^Numpad(\d)$/.exec(code)
  if (numpad) return `num${numpad[1]}`
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code
  return NAMED[code] ?? null
}

/** The held modifiers in Electron's order, e.g. ["Ctrl", "Alt"]. */
function modifiers(press: KeyPress): string[] {
  const held: string[] = []
  if (press.ctrlKey) held.push('Ctrl')
  if (press.altKey) held.push('Alt')
  if (press.shiftKey) held.push('Shift')
  if (press.metaKey) held.push('Super')
  return held
}

export function readShortcut(press: KeyPress): ShortcutRead {
  const held = modifiers(press)
  if (MODIFIER_CODES.has(press.code))
    return { kind: 'partial', held: held.map((m) => `${m}+`).join('') }
  if (press.code === 'Escape' && held.length === 0) return { kind: 'cancel' }
  const key = keyName(press.code)
  if (key === null) return { kind: 'unknown' }
  return { kind: 'combo', accelerator: [...held, key].join('+') }
}
