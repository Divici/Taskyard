export type JobPriority = 'high' | 'low'

/**
 * Async jobs, FIFO per priority, with at most `concurrency` running at once. A `low` job starts
 * only while no `high` job is waiting or running (the icon pipeline sends every 32 px icon before
 * extracting any large one). `idle()` resolves once nothing is queued, running or tracked. A
 * failing job is reported and never stops the queue.
 */
export interface JobQueue {
  run(job: () => Promise<void>, priority?: JobPriority): void
  /** Counts `work` as running until it settles (for work that queues jobs later). */
  track(work: Promise<unknown>): void
  idle(): Promise<void>
}

export function createJobQueue(concurrency: number, onError: (error: unknown) => void): JobQueue {
  const waiting: Record<JobPriority, Array<() => Promise<void>>> = { high: [], low: [] }
  const running: Record<JobPriority, number> = { high: 0, low: 0 }
  let tracked = 0
  let waiters: Array<() => void> = []

  const busy = (): boolean =>
    running.high + running.low + tracked + waiting.high.length + waiting.low.length > 0

  const settleIdle = (): void => {
    if (busy()) return
    const done = waiters
    waiters = []
    for (const resolve of done) resolve()
  }

  const next = (): JobPriority | null => {
    if (running.high + running.low >= concurrency) return null
    if (waiting.high.length > 0) return 'high'
    if (running.high === 0 && waiting.low.length > 0) return 'low'
    return null
  }

  const pump = (): void => {
    for (let priority = next(); priority !== null; priority = next()) {
      const lane = priority
      const job = waiting[lane].shift()!
      running[lane]++
      job()
        .catch(onError)
        .finally(() => {
          running[lane]--
          pump()
          settleIdle()
        })
    }
  }

  return {
    run(job, priority = 'high') {
      waiting[priority].push(job)
      pump()
    },
    track(work) {
      tracked++
      work.catch(onError).finally(() => {
        tracked--
        pump()
        settleIdle()
      })
    },
    idle() {
      return new Promise((resolve) => {
        waiters.push(resolve)
        settleIdle()
      })
    }
  }
}
