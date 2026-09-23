import { describe, expect, it } from 'vitest'
import { makeRect, mockRect, restoreRects } from './dnd-rects'

describe('makeRect', () => {
  it('derives every edge from position and size', () => {
    expect(makeRect({ x: 10, y: 20, width: 100, height: 50 })).toMatchObject({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 110,
      bottom: 70,
      width: 100,
      height: 50
    })
  })

  it('defaults the origin to 0,0 and serialises like a DOMRect', () => {
    const rect = makeRect({ width: 5, height: 6 })
    expect(rect.toJSON()).toEqual({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 5,
      bottom: 6,
      width: 5,
      height: 6
    })
  })
})

describe('mockRect', () => {
  it('makes getBoundingClientRect report the given rect', () => {
    const el = document.createElement('div')

    mockRect(el, { x: 40, y: 30, width: 120, height: 80 })

    expect(el.getBoundingClientRect()).toMatchObject({ left: 40, top: 30, right: 160, bottom: 110 })
  })

  it('re-reads a function spec on every call so a test can move the element', () => {
    const el = document.createElement('div')
    let x = 0
    mockRect(el, () => ({ x, y: 0, width: 10, height: 10 }))

    expect(el.getBoundingClientRect().left).toBe(0)
    x = 25
    expect(el.getBoundingClientRect().left).toBe(25)
  })

  it('only affects the mocked element', () => {
    const mocked = document.createElement('div')
    const other = document.createElement('div')

    mockRect(mocked, { width: 10, height: 10 })

    expect(other.getBoundingClientRect().width).toBe(0)
  })

  it('returns a function that restores the real measurement', () => {
    const el = document.createElement('div')
    const restore = mockRect(el, { width: 10, height: 10 })

    restore()

    expect(el.getBoundingClientRect().width).toBe(0)
  })

  it('restoreRects restores every mocked element', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')
    mockRect(a, { width: 10, height: 10 })
    mockRect(b, { width: 20, height: 20 })

    restoreRects()

    expect(a.getBoundingClientRect().width).toBe(0)
    expect(b.getBoundingClientRect().width).toBe(0)
  })
})
