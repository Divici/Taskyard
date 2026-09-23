/** The globals the polyfills patch; `window` in tests, a bare stand-in when testing the shims. */
export interface PolyfillScope {
  Element: typeof Element
  MouseEvent: typeof MouseEvent
  PointerEvent?: typeof PointerEvent
}

const captures = new WeakMap<Element, Set<number>>()

function capturedPointers(element: Element): Set<number> {
  let pointers = captures.get(element)
  if (!pointers) {
    pointers = new Set()
    captures.set(element, pointers)
  }
  return pointers
}

function installPointerCapture(proto: Element): void {
  if (typeof proto.setPointerCapture !== 'function') {
    proto.setPointerCapture = function (this: Element, pointerId: number) {
      capturedPointers(this).add(pointerId)
    }
  }
  if (typeof proto.releasePointerCapture !== 'function') {
    proto.releasePointerCapture = function (this: Element, pointerId: number) {
      capturedPointers(this).delete(pointerId)
    }
  }
  if (typeof proto.hasPointerCapture !== 'function') {
    proto.hasPointerCapture = function (this: Element, pointerId: number) {
      return capturedPointers(this).has(pointerId)
    }
  }
}

function createPointerEventShim(Base: typeof MouseEvent): typeof PointerEvent {
  class PointerEventShim extends Base {
    readonly pointerId: number
    readonly width: number
    readonly height: number
    readonly pressure: number
    readonly tangentialPressure: number
    readonly tiltX: number
    readonly tiltY: number
    readonly twist: number
    readonly pointerType: string
    readonly isPrimary: boolean

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
      this.width = init.width ?? 1
      this.height = init.height ?? 1
      this.pressure = init.pressure ?? 0
      this.tangentialPressure = init.tangentialPressure ?? 0
      this.tiltX = init.tiltX ?? 0
      this.tiltY = init.tiltY ?? 0
      this.twist = init.twist ?? 0
      this.pointerType = init.pointerType ?? ''
      this.isPrimary = init.isPrimary ?? false
    }

    getCoalescedEvents(): PointerEvent[] {
      return []
    }

    getPredictedEvents(): PointerEvent[] {
      return []
    }
  }
  return PointerEventShim as unknown as typeof PointerEvent
}

/**
 * jsdom lacks Element pointer capture (used by resize handles and dnd-kit's PointerSensor) and,
 * before v22, PointerEvent itself. Existing native implementations are left untouched.
 */
export function installPointerPolyfills(scope: PolyfillScope = window): void {
  installPointerCapture(scope.Element.prototype)
  if (typeof scope.PointerEvent !== 'function') {
    scope.PointerEvent = createPointerEventShim(scope.MouseEvent)
  }
}
