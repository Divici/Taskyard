/** One automated check of `npm run verify:zorder`. */
export interface CheckResult {
  title: string
  pass: boolean
  detail: string
}

export function formatCheck(number: number, result: CheckResult): string {
  return `${result.pass ? 'PASS' : 'FAIL'}  ${number}. ${result.title}: ${result.detail}`
}

/** A check that could not run because an earlier step failed. */
export function notRun(title: string, reason: string): CheckResult {
  return { title, pass: false, detail: `not run (${reason})` }
}

/** The overall line: PASS only when all `expected` checks ran and passed. */
export function formatSummary(results: readonly CheckResult[], expected: number): string {
  const passed = results.filter((result) => result.pass).length
  const verdict = passed === expected && results.length === expected ? 'PASS' : 'FAIL'
  return `verify:zorder: ${verdict} (${passed}/${expected} checks)`
}
