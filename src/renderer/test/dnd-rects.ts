import { vi, type MockInstance } from 'vitest'

/** Position and size of a mocked element; `x`/`y` are the left/top edges (default 0). */
export interface RectSpec {
  x?: number
  y?: number
  width: number
  height: number
}

/** A DOMRect-shaped value with every edge derived from position and size. */
export function makeRect({ x = 0, y = 0, width, height }: RectSpec): DOMRect {
  const edges = { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height }
  return { ...edges, toJSON: () => ({ ...edges }) }
}

const activeMocks = new Set<MockInstance<() => DOMRect>>()

/**
 * jsdom reports 0×0 for every element, but dnd-kit measures draggables and droppables through
 * getBoundingClientRect. Pass a function to re-measure on each call (e.g. after a move).
 * Returns a restore function; setupTests also restores every mock after each test.
 */
export function mockRect(element: Element, spec: RectSpec | (() => RectSpec)): () => void {
  const spy = vi
    .spyOn(element, 'getBoundingClientRect')
    .mockImplementation(() => makeRect(typeof spec === 'function' ? spec() : spec))
  activeMocks.add(spy)
  return () => {
    spy.mockRestore()
    activeMocks.delete(spy)
  }
}

export function restoreRects(): void {
  for (const spy of activeMocks) spy.mockRestore()
  activeMocks.clear()
}
