import { describe, expect, it, vi } from 'vitest'
import { createJobQueue } from './job-queue'

/** A job that runs until `finish()` is called, recording when it starts. */
function gate(log: string[], name: string): { job: () => Promise<void>; finish: () => void } {
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => (finish = resolve))
  return {
    job: async () => {
      log.push(`start ${name}`)
      await done
      log.push(`end ${name}`)
    },
    finish: () => finish()
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('createJobQueue', () => {
  it('runs at most `concurrency` jobs at once, first in first out', async () => {
    const log: string[] = []
    const queue = createJobQueue(2, vi.fn())
    const gates = ['a', 'b', 'c'].map((name) => gate(log, name))
    for (const { job } of gates) queue.run(job)

    expect(log).toEqual(['start a', 'start b'])
    gates[0].finish()
    await tick()
    expect(log).toEqual(['start a', 'start b', 'end a', 'start c'])
    gates[1].finish()
    gates[2].finish()
    await queue.idle()
  })

  it('starts a low-priority job only when no high-priority job is waiting or running', async () => {
    const log: string[] = []
    const queue = createJobQueue(2, vi.fn())
    const high = gate(log, 'high')
    const low = gate(log, 'low')
    queue.run(high.job)
    queue.run(low.job, 'low')

    await tick()
    expect(log).toEqual(['start high'])
    high.finish()
    await tick()
    expect(log).toEqual(['start high', 'end high', 'start low'])
    low.finish()
    await queue.idle()
  })

  it('idle() waits for queued, running and tracked work, and resolves at once when empty', async () => {
    const queue = createJobQueue(1, vi.fn())
    await queue.idle()

    const log: string[] = []
    const job = gate(log, 'job')
    let releaseTracked: () => void = () => {}
    queue.run(job.job)
    queue.track(new Promise<void>((resolve) => (releaseTracked = resolve)))
    let idle = false
    void queue.idle().then(() => (idle = true))

    job.finish()
    await tick()
    expect(idle).toBe(false)
    releaseTracked()
    await tick()
    expect(idle).toBe(true)
  })

  it('reports a failing job and keeps going', async () => {
    const onError = vi.fn()
    const queue = createJobQueue(1, onError)
    const after = vi.fn(async () => {})
    queue.run(async () => {
      throw new Error('boom')
    })
    queue.run(after)

    await queue.idle()

    expect(onError).toHaveBeenCalledWith(new Error('boom'))
    expect(after).toHaveBeenCalledOnce()
  })
})
