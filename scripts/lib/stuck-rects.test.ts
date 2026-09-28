import { describe, expect, it } from 'vitest'
import {
  parseRegBinary,
  STUCK_RECTS_KEY,
  stuckRectsAddArgs,
  stuckRectsAutoHide,
  withStuckRectsAutoHide
} from './stuck-rects'

// `reg query <key> /v Settings` on this machine (bottom taskbar, 2560x1440), auto-hide on.
const AUTO_HIDE_ON =
  '30000000FEFFFFFF030000000300000090000000300000000000000070050000000A0000A00500006000000001000000'
const KEY_PATH = String.raw`Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3`
const STDOUT = `\r\nHKEY_CURRENT_USER\\${KEY_PATH}\r\n    Settings    REG_BINARY    ${AUTO_HIDE_ON}\r\n\r\n`

describe('STUCK_RECTS_KEY', () => {
  it("is the current user's StuckRects3 key, backslashes intact", () => {
    expect(STUCK_RECTS_KEY).toBe(`HKCU\\${KEY_PATH}`)
  })
})

describe('parseRegBinary', () => {
  it('reads the REG_BINARY value out of `reg query` output', () => {
    const bytes = parseRegBinary(STDOUT)

    expect(bytes).not.toBeNull()
    expect(bytes!.length).toBe(48)
    expect(bytes![8]).toBe(0x03)
  })

  it('is null when the output has no binary value (key or value missing)', () => {
    expect(parseRegBinary('ERROR: The system was unable to find the specified registry key')).toBe(
      null
    )
  })
})

describe('stuckRectsAutoHide', () => {
  it('reads the auto-hide bit (byte 8, bit 0) Explorer loads at start', () => {
    expect(stuckRectsAutoHide(Buffer.from(AUTO_HIDE_ON, 'hex'))).toBe(true)
    expect(stuckRectsAutoHide(Buffer.from(AUTO_HIDE_ON.replace(/^(.{16})03/, '$102'), 'hex'))).toBe(
      false
    )
  })

  it('is null for a value too short to hold the flags', () => {
    expect(stuckRectsAutoHide(Buffer.from('3000000000', 'hex'))).toBeNull()
  })
})

describe('withStuckRectsAutoHide', () => {
  it('changes only the auto-hide bit and leaves the input untouched', () => {
    const on = Buffer.from(AUTO_HIDE_ON, 'hex')

    const off = withStuckRectsAutoHide(on, false)

    expect(off[8]).toBe(0x02)
    expect(off.toString('hex').toUpperCase()).toBe(AUTO_HIDE_ON.replace(/^(.{16})03/, '$102'))
    expect(on[8]).toBe(0x03)
    expect(withStuckRectsAutoHide(off, true).toString('hex').toUpperCase()).toBe(AUTO_HIDE_ON)
  })
})

describe('stuckRectsAddArgs', () => {
  it('writes the whole value back with reg add', () => {
    expect(stuckRectsAddArgs(Buffer.from(AUTO_HIDE_ON, 'hex'))).toEqual([
      'add',
      STUCK_RECTS_KEY,
      '/v',
      'Settings',
      '/t',
      'REG_BINARY',
      '/d',
      AUTO_HIDE_ON,
      '/f'
    ])
  })
})
