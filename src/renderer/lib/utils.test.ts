import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('lets the later Tailwind utility win a conflict', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4')
  })

  it('drops falsy values and flattens conditional objects and arrays', () => {
    const hidden = false
    expect(cn('a', hidden && 'b', undefined, null, { c: true, d: false }, ['e'])).toBe('a c e')
  })
})
