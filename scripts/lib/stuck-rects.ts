import { spawnSync } from 'node:child_process'

/**
 * Where Explorer persists the taskbar's settings. It reads this at start, so an Explorer restart
 * (verify:zorder's check 5) brings back whatever auto-hide bit is saved here. `ABM_SETSTATE`
 * does not reliably write it: measured, Explorer sometimes saves auto-hide ON a moment after it
 * is switched on and never saves the switch back off (only a graceful Explorer exit does).
 */
export const STUCK_RECTS_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3`
const VALUE = 'Settings'
/** Byte 8 of the value holds the flags; bit 0 is auto-hide (0x02 off, 0x03 on, measured). */
const FLAGS_BYTE = 8
const AUTO_HIDE_BIT = 0x1

/** The REG_BINARY data in `reg query` output, or null when there is none. */
export function parseRegBinary(stdout: string): Buffer | null {
  const match = /REG_BINARY\s+([0-9A-Fa-f]+)/.exec(stdout)
  return match ? Buffer.from(match[1], 'hex') : null
}

/** The persisted auto-hide bit, or null when the value is too short to hold it. */
export function stuckRectsAutoHide(bytes: Buffer): boolean | null {
  if (bytes.length <= FLAGS_BYTE) return null
  return (bytes[FLAGS_BYTE] & AUTO_HIDE_BIT) !== 0
}

/** A copy of `bytes` with only the auto-hide bit set to `on`. */
export function withStuckRectsAutoHide(bytes: Buffer, on: boolean): Buffer {
  const copy = Buffer.from(bytes)
  copy[FLAGS_BYTE] = on ? copy[FLAGS_BYTE] | AUTO_HIDE_BIT : copy[FLAGS_BYTE] & ~AUTO_HIDE_BIT
  return copy
}

/** `reg add` arguments that write `bytes` back as the whole value. */
export function stuckRectsAddArgs(bytes: Buffer): string[] {
  const hex = bytes.toString('hex').toUpperCase()
  return ['add', STUCK_RECTS_KEY, '/v', VALUE, '/t', 'REG_BINARY', '/d', hex, '/f']
}

/** Reads and writes the persisted auto-hide bit with reg.exe (synchronous, for Ctrl+C too). */
export function stuckRectsRegistry(): {
  autoHide(): boolean | null
  setAutoHide(on: boolean): void
} {
  const read = (): Buffer | null => {
    const result = spawnSync('reg', ['query', STUCK_RECTS_KEY, '/v', VALUE], {
      encoding: 'utf8',
      windowsHide: true
    })
    return result.status === 0 ? parseRegBinary(result.stdout ?? '') : null
  }
  return {
    autoHide() {
      const bytes = read()
      return bytes === null ? null : stuckRectsAutoHide(bytes)
    },
    setAutoHide(on) {
      const bytes = read()
      if (bytes === null || stuckRectsAutoHide(bytes) === null) return
      spawnSync('reg', stuckRectsAddArgs(withStuckRectsAutoHide(bytes, on)), {
        stdio: 'ignore',
        windowsHide: true
      })
    }
  }
}
