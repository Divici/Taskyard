import { describe, expect, it } from 'vitest'
import { installPointerPolyfills, type PolyfillScope } from './pointer-polyfills'

describe('pointer polyfills (installed by setupTests)', () => {
  it('tracks pointer capture per element and pointer id', () => {
    const a = document.createElement('div')
    const b = document.createElement('div')

    a.setPointerCapture(1)

    expect(a.hasPointerCapture(1)).toBe(true)
    expect(a.hasPointerCapture(2)).toBe(false)
    expect(b.hasPointerCapture(1)).toBe(false)

    a.releasePointerCapture(1)
    expect(a.hasPointerCapture(1)).toBe(false)
  })

  it('provides a PointerEvent that carries pointer fields and extends MouseEvent', () => {
    const event = new PointerEvent('pointerdown', {
      pointerId: 7,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: 12,
      clientY: 34,
      bubbles: true
    })

    expect(event).toBeInstanceOf(MouseEvent)
    expect(event.pointerId).toBe(7)
    expect(event.pointerType).toBe('mouse')
    expect(event.isPrimary).toBe(true)
    expect(event.clientX).toBe(12)
    expect(event.clientY).toBe(34)
  })
})

describe('installPointerPolyfills', () => {
  function bareScope(): PolyfillScope {
    class BareElement {}
    return { Element: BareElement as unknown as typeof Element, MouseEvent: window.MouseEvent }
  }

  it('adds pointer capture methods to an Element prototype that lacks them', () => {
    const scope = bareScope()

    installPointerPolyfills(scope)

    const element = new (scope.Element as unknown as new () => Element)()
    element.setPointerCapture(3)
    expect(element.hasPointerCapture(3)).toBe(true)
    element.releasePointerCapture(3)
    expect(element.hasPointerCapture(3)).toBe(false)
  })

  it('shims PointerEvent on top of MouseEvent when it is missing', () => {
    const scope = bareScope()

    installPointerPolyfills(scope)

    const Shim = scope.PointerEvent!
    const event = new Shim('pointermove', { pointerId: 2, width: 4, pressure: 0.5, clientX: 9 })
    expect(event).toBeInstanceOf(window.MouseEvent)
    expect(event.type).toBe('pointermove')
    expect(event.pointerId).toBe(2)
    expect(event.width).toBe(4)
    expect(event.height).toBe(1)
    expect(event.pressure).toBe(0.5)
    expect(event.pointerType).toBe('')
    expect(event.isPrimary).toBe(false)
    expect(event.clientX).toBe(9)
    expect(event.getCoalescedEvents()).toEqual([])
  })

  it('keeps existing native implementations', () => {
    const scope = bareScope()
    const nativeCapture = (): void => undefined
    Object.assign(scope.Element.prototype, { setPointerCapture: nativeCapture })
    const NativePointerEvent = class extends window.MouseEvent {} as unknown as typeof PointerEvent
    scope.PointerEvent = NativePointerEvent

    installPointerPolyfills(scope)

    expect(scope.Element.prototype.setPointerCapture).toBe(nativeCapture)
    expect(scope.PointerEvent).toBe(NativePointerEvent)
  })
})
