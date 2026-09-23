import type { AxeMatchers } from 'vitest-axe/matchers'

// vitest-axe 0.1 only augments the legacy global `Vi` namespace; vitest 3 reads matchers from
// the 'vitest' module, so register toHaveNoViolations there. The type parameter must match
// vitest's own declaration exactly for the interfaces to merge.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  interface Assertion<T = any> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
