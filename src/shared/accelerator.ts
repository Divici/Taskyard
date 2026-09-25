// Electron accelerator validation for the rebindable Peek shortcut. Pure and zod-free: main
// validates before `globalShortcut.register`, and the settings UI (Phase 11) can show the same
// verdict inline. Grammar: https://www.electronjs.org/docs/latest/api/accelerator

/** Longer strings are refused outright (the settings schema caps the field at 64). */
const MAX_LENGTH = 64

/** Modifier spellings Electron accepts (lower case) → the canonical spelling written back. */
const MODIFIERS: Readonly<Record<string, string>> = {
  command: 'Command',
  cmd: 'Command',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Meta'
}

/** Named key codes (lower case) → canonical spelling. Letters, digits and F-keys are added below. */
const NAMED_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  [
    'Plus',
    'Space',
    'Tab',
    'Capslock',
    'Numlock',
    'Scrolllock',
    'Backspace',
    'Delete',
    'Insert',
    'Return',
    'Enter',
    'Up',
    'Down',
    'Left',
    'Right',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Escape',
    'Esc',
    'VolumeUp',
    'VolumeDown',
    'VolumeMute',
    'MediaNextTrack',
    'MediaPreviousTrack',
    'MediaStop',
    'MediaPlayPause',
    'PrintScreen',
    'numdec',
    'numadd',
    'numsub',
    'nummult',
    'numdiv',
    ...Array.from({ length: 10 }, (_, digit) => `num${digit}`),
    ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`)
  ].map((key) => [key.toLowerCase(), key])
)

/** Punctuation keys Electron maps by character. `+` itself is spelled `Plus`. */
const PUNCTUATION = new Set([...')!@#$%^&*(:;<=>?_-~{|}[]\\\'",./`'])

const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/

function keyCode(part: string): string | null {
  if (/^[a-z0-9]$/i.test(part)) return part.toUpperCase()
  if (PUNCTUATION.has(part)) return part
  return NAMED_KEYS[part.toLowerCase()] ?? null
}

/**
 * The accelerator in canonical form ("control + alt + space" → "Ctrl+Alt+Space"), or null when
 * Electron would refuse it or it would make a poor global shortcut: modifiers first, each at most
 * once, then exactly one key; at least one modifier other than Shift, except for a bare function
 * key (F1–F24). A global shortcut on a plain letter or Space would swallow that key everywhere.
 */
export function normalizeAccelerator(input: string): string | null {
  if (input.length > MAX_LENGTH) return null
  const parts = input.split('+').map((part) => part.trim())
  if (parts.some((part) => part === '')) return null
  const key = keyCode(parts[parts.length - 1])
  if (key === null) return null
  const modifiers: string[] = []
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIERS[part.toLowerCase()]
    if (modifier === undefined || modifiers.includes(modifier)) return null
    modifiers.push(modifier)
  }
  const strong = modifiers.some((modifier) => modifier !== 'Shift')
  if (!strong && !FUNCTION_KEY.test(key)) return null
  return [...modifiers, key].join('+')
}
