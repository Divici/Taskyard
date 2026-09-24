import { describe, expect, it } from 'vitest'
import { formatCheck, formatSummary, notRun, type CheckResult } from './zorder-report'

const pass = (title: string): CheckResult => ({ title, pass: true, detail: 'ok' })
const fail = (title: string): CheckResult => ({ title, pass: false, detail: 'broken' })

describe('formatCheck', () => {
  it('prints PASS or FAIL, the number, the title and the detail', () => {
    expect(formatCheck(1, pass('Notepad above Taskyard'))).toBe(
      'PASS  1. Notepad above Taskyard: ok'
    )
    expect(formatCheck(5, fail('Explorer restart'))).toBe('FAIL  5. Explorer restart: broken')
  })
})

describe('notRun', () => {
  it('is a failed check that says why it did not run', () => {
    expect(notRun('Win+D', 'Taskyard never showed a window')).toEqual({
      title: 'Win+D',
      pass: false,
      detail: 'not run (Taskyard never showed a window)'
    })
  })
})

describe('formatSummary', () => {
  it('passes only when every expected check ran and passed', () => {
    expect(formatSummary([pass('a'), pass('b')], 2)).toBe('verify:zorder: PASS (2/2 checks)')
  })

  it('fails when any check failed', () => {
    expect(formatSummary([pass('a'), fail('b')], 2)).toBe('verify:zorder: FAIL (1/2 checks)')
  })

  it('fails when fewer checks ran than expected', () => {
    expect(formatSummary([pass('a')], 2)).toBe('verify:zorder: FAIL (1/2 checks)')
  })
})
