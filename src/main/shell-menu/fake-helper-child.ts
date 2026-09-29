import { EventEmitter } from 'node:events'
import { createFakeShellMenuApi } from '../win32/shell-menu-fake'
import type { ShellMenuApi } from '../win32/shell-menu-api'
import { createHelperCore } from './helper-core'
import type { HelperChild } from './host'
import type { HelperMessage } from './protocol'

export interface FakeHelperChildOptions {
  api?: ShellMenuApi
  pid?: number
}

/**
 * A helper "process" that runs the real helper core in-process over a fake shell-menu api:
 * messages cross asynchronously in both directions, like a utility process's MessagePort. For
 * headless host tests (and a fake shell-menu mode without Win32).
 */
export class FakeHelperChild extends EventEmitter implements HelperChild {
  readonly pid: number
  killed = false
  private exited = false
  private readonly core: { handle(raw: unknown): void }

  constructor(options: FakeHelperChildOptions = {}) {
    super()
    this.pid = options.pid ?? 4242
    const api = options.api ?? createFakeShellMenuApi()
    this.core = createHelperCore({ api, post: (message) => this.deliver(message) })
    this.deliver({ type: 'ready', pid: this.pid })
  }

  postMessage(message: unknown): void {
    if (this.exited) return
    // Structured clone, like the real channel: the core never shares objects with main.
    const copy = structuredClone(message)
    queueMicrotask(() => {
      if (!this.exited) this.core.handle(copy)
    })
  }

  kill(): boolean {
    if (this.exited) return false
    this.killed = true
    this.crash(1)
    return true
  }

  /** The helper process dies (a shell extension crashed it). */
  crash(code = 0xc0000005): void {
    if (this.exited) return
    this.exited = true
    queueMicrotask(() => this.emit('exit', code))
  }

  private deliver(message: HelperMessage): void {
    const copy = structuredClone(message)
    queueMicrotask(() => {
      if (!this.exited) this.emit('message', copy)
    })
  }
}
