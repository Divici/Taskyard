import { describe, expect, it, vi } from 'vitest'
import { boot, BOOT_STEPS, STOP_BOOT, type BootSteps } from './boot'
import { startDesktop } from './start-desktop'

function quietLog(): { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), error: vi.fn() }
}

function recordingSteps(order: string[]): BootSteps {
  const step = (name: string): (() => void) => vi.fn(() => void order.push(name))
  return {
    loadStores: step('loadStores'),
    replayJournal: step('replayJournal'),
    createWindows: step('createWindows'),
    scan: step('scan'),
    watch: step('watch')
  }
}

describe('boot', () => {
  it('runs stores → journal replay → windows → scan → watch', async () => {
    const order: string[] = []

    await boot(recordingSteps(order), quietLog())

    expect(BOOT_STEPS).toEqual(['loadStores', 'replayJournal', 'createWindows', 'scan', 'watch'])
    expect(order).toEqual([...BOOT_STEPS])
  })

  it('waits for an async step to settle before starting the next one', async () => {
    const order: string[] = []
    const steps = recordingSteps(order)
    steps.loadStores = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('loadStores')
    })

    await boot(steps, quietLog())

    expect(order).toEqual([...BOOT_STEPS])
  })

  it('logs a failing step and still runs the rest, so the app keeps its windows', async () => {
    const order: string[] = []
    const steps = recordingSteps(order)
    const failure = new Error('ops.json locked')
    steps.replayJournal = vi.fn(async () => {
      throw failure
    })
    const log = quietLog()

    const report = await boot(steps, log)

    expect(order).toEqual(['loadStores', 'createWindows', 'scan', 'watch'])
    expect(report.failed).toEqual(['replayJournal'])
    expect(log.error).toHaveBeenCalledWith('boot: replayJournal failed', failure)
  })

  it('logs how long each step took', async () => {
    const log = quietLog()

    const report = await boot(recordingSteps([]), log)

    expect(Object.keys(report.durationsMs)).toEqual([...BOOT_STEPS])
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/^boot: loadStores \d+ ms$/))
  })

  it('ends the boot when createWindows fails: logged, then onFatal (the app quits), and no scan or watch', async () => {
    const order: string[] = []
    const steps = recordingSteps(order)
    const failure = new Error('Menu.setApplicationMenu threw')
    steps.createWindows = vi.fn(async () => {
      throw failure
    })
    const log = quietLog()
    const onFatal = vi.fn(() => {
      expect(log.error).toHaveBeenCalledWith('boot: createWindows failed', failure)
    })

    const report = await boot(steps, log, { onFatal })

    expect(order).toEqual(['loadStores', 'replayJournal'])
    expect(onFatal).toHaveBeenCalledExactlyOnceWith('createWindows', failure)
    expect(report).toMatchObject({ failed: ['createWindows'], skipped: ['scan', 'watch'] })
    expect(log.info).toHaveBeenCalledWith('boot: stopped after createWindows; skipping scan, watch')
  })

  it('ends the boot quietly when a step returns STOP_BOOT: nothing after it runs', async () => {
    const order: string[] = []
    const steps = recordingSteps(order)
    steps.createWindows = vi.fn(() => STOP_BOOT)
    const onFatal = vi.fn()

    const report = await boot(steps, quietLog(), { onFatal })

    expect(order).toEqual(['loadStores', 'replayJournal'])
    expect(report).toMatchObject({ failed: [], skipped: ['scan', 'watch'] })
    expect(onFatal).not.toHaveBeenCalled()
  })

  it('runs no scan or watch when startDesktop gives up (as index.ts wires createWindows)', async () => {
    const order: string[] = []
    const steps = recordingSteps(order)
    const quit = vi.fn()
    // index.ts: `desktop = startDesktop(await win32, deps); return desktop ?? STOP_BOOT`
    steps.createWindows = () =>
      startDesktop(
        { kind: 'unavailable', reason: 'koffi could not load user32.dll' },
        {
          clearApplicationMenu: vi.fn(),
          createManager: vi.fn(),
          registerIpc: vi.fn(),
          showErrorBox: vi.fn(),
          quit,
          log: { info: vi.fn(), error: vi.fn() },
          logFile: 'C:\\logs\\main.log'
        }
      ) ?? STOP_BOOT

    await boot(steps, quietLog())

    expect(quit).toHaveBeenCalledOnce()
    expect(order).toEqual(['loadStores', 'replayJournal'])
  })

  it('keeps going after a failing step that is not fatal (a failing scan still lets watch run)', async () => {
    const order: string[] = []
    const steps = recordingSteps(order)
    steps.scan = vi.fn(() => {
      throw new Error('Desktop folder unreadable')
    })
    const onFatal = vi.fn()

    await boot(steps, quietLog(), { onFatal })

    expect(order).toEqual(['loadStores', 'replayJournal', 'createWindows', 'watch'])
    expect(onFatal).not.toHaveBeenCalled()
  })
})
