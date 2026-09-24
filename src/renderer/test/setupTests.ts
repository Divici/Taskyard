import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import * as axeMatchers from 'vitest-axe/matchers'
import { afterEach, expect, vi } from 'vitest'
import { restoreRects } from './dnd-rects'
import { installPointerPolyfills } from './pointer-polyfills'
import { resetStores } from './reset-stores'

expect.extend(axeMatchers)

// jsdom has no pointer capture (and older versions no PointerEvent); resize handles and
// dnd-kit's PointerSensor rely on both.
installPointerPolyfills()

// jsdom cannot render canvas and logs "Not implemented" when axe-core probes it; report "no
// context available" instead, as a browser would, and axe skips the pixel-based checks.
HTMLCanvasElement.prototype.getContext = () => null

// Testing Library's asyncWrapper (used by user-event and waitFor) drains with a setTimeout(0) and
// only advances fake timers when a global `jest` exists; under vitest fake timers that timeout
// never fires and every user-event call hangs. Expose the one method it calls.
if (!('jest' in globalThis)) {
  Object.defineProperty(globalThis, 'jest', {
    value: { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) },
    configurable: true
  })
}

afterEach(() => {
  cleanup()
  restoreRects()
  // The zustand stores are module singletons: start every test from their initial state, with
  // no preload bridge unless the test installs a fake one.
  resetStores()
  Reflect.deleteProperty(window, 'taskyard')
  vi.restoreAllMocks()
})
