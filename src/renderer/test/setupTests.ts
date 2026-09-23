import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import * as axeMatchers from 'vitest-axe/matchers'
import { afterEach, expect } from 'vitest'
import { restoreRects } from './dnd-rects'
import { installPointerPolyfills } from './pointer-polyfills'

expect.extend(axeMatchers)

// jsdom has no pointer capture (and older versions no PointerEvent); resize handles and
// dnd-kit's PointerSensor rely on both.
installPointerPolyfills()

// jsdom cannot render canvas and logs "Not implemented" when axe-core probes it; report "no
// context available" instead, as a browser would, and axe skips the pixel-based checks.
HTMLCanvasElement.prototype.getContext = () => null

afterEach(() => {
  cleanup()
  restoreRects()
})
