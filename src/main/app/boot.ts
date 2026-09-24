/**
 * Startup order. The journal must be replayed after the stores load (it may scrub the layout) and
 * before any window hydrates from them or the scanner sees the desktop, so an interrupted move is
 * resolved before anything observes it.
 */
export const BOOT_STEPS = ['loadStores', 'replayJournal', 'createWindows', 'scan', 'watch'] as const

export type BootStepName = (typeof BOOT_STEPS)[number]

/** A step returns this to end the boot on purpose (e.g. no desktop windows: the app is quitting). */
export const STOP_BOOT: unique symbol = Symbol('stop boot')

export type BootSteps = Record<BootStepName, () => unknown>

/**
 * Steps the app cannot run without. When one throws, the boot ends there (the steps after it
 * need its result) and `onFatal` is told, so the app can quit instead of lingering windowless
 * while it holds the single-instance lock.
 */
export const FATAL_BOOT_STEPS: readonly BootStepName[] = ['createWindows']

export interface BootLog {
  info(message: string): void
  error(message: string, error: unknown): void
}

export interface BootOptions {
  /** A fatal step threw (already logged). index.ts quits the app. */
  onFatal?: (step: BootStepName, error: unknown) => void
}

export interface BootReport {
  failed: BootStepName[]
  /** Steps that never ran because an earlier one stopped the boot. */
  skipped: BootStepName[]
  durationsMs: Partial<Record<BootStepName, number>>
}

/**
 * Runs the steps strictly one after another. A failing step is logged and the rest still run (a
 * broken journal or scanner must not leave the user without windows), except a fatal step
 * (`FATAL_BOOT_STEPS`), which ends the boot and calls `onFatal`. A step that returns `STOP_BOOT`
 * ends the boot quietly.
 */
export async function boot(
  steps: BootSteps,
  log: BootLog,
  { onFatal }: BootOptions = {}
): Promise<BootReport> {
  const failed: BootStepName[] = []
  const durationsMs: Partial<Record<BootStepName, number>> = {}

  for (const [index, name] of BOOT_STEPS.entries()) {
    const started = performance.now()
    let stop = false
    try {
      stop = (await steps[name]()) === STOP_BOOT
    } catch (error) {
      failed.push(name)
      log.error(`boot: ${name} failed`, error)
      if (FATAL_BOOT_STEPS.includes(name)) {
        stop = true
        onFatal?.(name, error)
      }
    }
    durationsMs[name] = Math.round(performance.now() - started)
    log.info(`boot: ${name} ${durationsMs[name]} ms`)
    if (stop) {
      const skipped = BOOT_STEPS.slice(index + 1)
      if (skipped.length > 0) {
        log.info(`boot: stopped after ${name}; skipping ${skipped.join(', ')}`)
      }
      return { failed, skipped, durationsMs }
    }
  }
  return { failed, skipped: [], durationsMs }
}
