/** Blocks the thread for `ms` (for synchronous cleanup paths such as a Ctrl+C handler). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
