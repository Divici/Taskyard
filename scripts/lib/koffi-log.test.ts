import { describe, expect, it } from 'vitest'
import { findKoffiResult, pollUntil, tailLines } from './koffi-log'

const PACKAGED = '[2026-09-23 10:00:00.123] [info]  koffi: user32 loaded (packaged)'
const DEV = '[2026-09-23 10:00:00.123] [info]  koffi: user32 loaded (dev)'
const FAILED =
  '[2026-09-23 10:00:00.123] [error] koffi: user32 load failed (packaged) Error: Cannot find the native Koffi module'

describe('findKoffiResult', () => {
  it('is pending while the probe line has not been written yet', () => {
    expect(findKoffiResult('')).toEqual({ status: 'pending' })
    expect(findKoffiResult('[..] [info]  app: starting Taskyard 0.1.0\n')).toEqual({
      status: 'pending'
    })
  })

  it('reports ok with the matching line for the expected flavour', () => {
    const log = `[..] [info]  app: starting\n${PACKAGED}\n[..] [info]  window: shown\n`
    expect(findKoffiResult(log)).toEqual({ status: 'ok', line: PACKAGED })
    expect(findKoffiResult(`${DEV}\r\n`, 'dev')).toEqual({ status: 'ok', line: DEV })
  })

  it('flags a success line from the wrong flavour', () => {
    expect(findKoffiResult(`${DEV}\n`)).toEqual({ status: 'wrong-mode', line: DEV })
  })

  it('reports a logged load failure', () => {
    expect(findKoffiResult(`${FAILED}\n    at load (index.cjs:1:1)\n`)).toEqual({
      status: 'failed',
      line: FAILED
    })
  })
})

describe('tailLines', () => {
  it('returns the last n non-empty lines', () => {
    expect(tailLines('a\nb\r\nc\n\nd\n', 3)).toBe('b\nc\nd')
    expect(tailLines('only\n', 5)).toBe('only')
    expect(tailLines('', 5)).toBe('')
  })
})

describe('pollUntil', () => {
  it('resolves with the first defined value', async () => {
    let calls = 0
    const value = await pollUntil(() => (++calls === 3 ? 'done' : undefined), {
      timeoutMs: 1000,
      intervalMs: 1
    })
    expect(value).toBe('done')
    expect(calls).toBe(3)
  })

  it('resolves undefined after the timeout', async () => {
    const started = Date.now()
    const value = await pollUntil(() => undefined, { timeoutMs: 50, intervalMs: 10 })
    expect(value).toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
  })
})
