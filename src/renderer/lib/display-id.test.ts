import { describe, expect, it } from 'vitest'
import { parseDisplayId } from './display-id'

describe('parseDisplayId', () => {
  it('reads the displayId the main process put in the URL', () => {
    expect(parseDisplayId('?displayId=2450156880')).toBe(2450156880)
    expect(parseDisplayId('?x=1&displayId=0')).toBe(0)
    expect(parseDisplayId('displayId=7')).toBe(7)
  })

  it.each([
    '',
    '?',
    '?other=1',
    '?displayId=',
    '?displayId=abc',
    '?displayId=-1',
    '?displayId=1.5'
  ])('returns null for %j', (search) => {
    expect(parseDisplayId(search)).toBeNull()
  })

  it('rejects ids beyond the safe integer range', () => {
    expect(parseDisplayId('?displayId=90071992547409930')).toBeNull()
  })
})
