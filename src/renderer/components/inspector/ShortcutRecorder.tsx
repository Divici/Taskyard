import { useEffect, useId, useRef, useState } from 'react'
import { normalizeAccelerator } from '@shared/accelerator'
import type { ShortcutStatus } from '@shared/ipc'
import { getBridge } from '../../lib/bridge'
import { cn } from '../../lib/utils'
import { useSettingsStore } from '../../stores/settings'
import { readShortcut } from './shortcut-keys'

// Settings › Peek shortcut (Phase 11). Click, press the new keys, done:
// 1. the keys are read by physical code and judged by the same `normalizeAccelerator` main uses;
//    a shortcut Windows should not own globally ("Shift+A") is refused inline, nothing saved;
// 2. a valid one is saved to settings; main registers it and answers with `peek:shortcut`;
// 3. if another app owns it (or Electron refuses it), the inline error says so and the previous
//    binding is saved back, which main then re-registers — the shortcut the user had keeps working.
// It is also where a default that is taken at start-up (Ctrl+Alt+Space, on some machines) is
// explained and fixed.

type Mode = 'idle' | 'recording'

interface Pending {
  candidate: string
  previous: string
}

interface Message {
  tone: 'error' | 'ok'
  text: string
}

/** Main answers a registration within milliseconds; after this, ask it directly. */
const STATUS_FALLBACK_MS = 2_000

/** What a status that failed at start-up (or on a save from elsewhere) means for the user. */
function statusProblem(status: ShortcutStatus | null): string | null {
  if (status === null || status.error === null) return null
  if (status.error === 'in-use') {
    return status.active === null
      ? `${status.accelerator} is used by another app, so Peek has no shortcut. Choose another.`
      : `${status.accelerator} is used by another app. Peek still uses ${status.active}.`
  }
  return status.active === null
    ? `“${status.accelerator}” isn’t a valid shortcut, so Peek has no shortcut. Choose another.`
    : `“${status.accelerator}” isn’t a valid shortcut. Peek still uses ${status.active}.`
}

function Keys({ accelerator }: { accelerator: string }): React.JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-0.5">
      {accelerator.split('+').map((key, index) => (
        <span key={`${key}-${index}`} className="flex items-center gap-0.5">
          {index > 0 && <span className="text-text-tertiary">+</span>}
          <kbd className="rounded-[5px] border border-text-primary/15 bg-text-primary/8 px-1.5 py-px font-sans text-[11px] font-medium text-text-primary">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  )
}

export function ShortcutRecorder(): React.JSX.Element {
  const current = useSettingsStore((state) => state.settings.peekShortcut)
  const [mode, setMode] = useState<Mode>('idle')
  const [held, setHeld] = useState('')
  const [message, setMessage] = useState<Message | null>(null)
  const [status, setStatus] = useState<ShortcutStatus | null>(null)
  const pending = useRef<Pending | null>(null)
  /** The status handler of the live subscription (the fallback pull feeds it too). */
  const settleRef = useRef<((status: ShortcutStatus) => void) | null>(null)
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null)
  const labelId = useId()
  const hintId = useId()

  // Main's registration outcome: pulled once, then followed.
  useEffect(() => {
    let live = true
    const api = getBridge()

    const settle = (next: ShortcutStatus): void => {
      const waiting = pending.current
      if (waiting === null || next.accelerator !== waiting.candidate) return
      pending.current = null
      if (fallback.current !== null) clearTimeout(fallback.current)
      fallback.current = null
      if (next.error === null) {
        setMessage({ tone: 'ok', text: `Peek now opens with ${next.accelerator}.` })
        return
      }
      // Keep what worked: the previous binding goes back into settings (main re-registers it).
      useSettingsStore.getState().update({ peekShortcut: waiting.previous })
      const kept = next.active ?? waiting.previous
      setMessage({
        tone: 'error',
        text:
          next.error === 'in-use'
            ? `${next.accelerator} is already used by another app. Peek keeps ${kept}.`
            : `Windows won’t accept “${next.accelerator}” as a shortcut. Peek keeps ${kept}.`
      })
    }

    const receive = (next: ShortcutStatus): void => {
      if (!live) return
      setStatus(next)
      settle(next)
    }

    const off = api.on('peek:shortcut', receive)
    api.peek
      .shortcutStatus()
      .then(receive, (error: unknown) =>
        console.error('settings: asking main for the Peek shortcut failed', error)
      )
    settleRef.current = receive
    return () => {
      live = false
      settleRef.current = null
      off()
      if (fallback.current !== null) clearTimeout(fallback.current)
    }
  }, [])

  const stop = (): void => {
    setMode('idle')
    setHeld('')
  }

  const commit = (accelerator: string): void => {
    stop()
    const canonical = normalizeAccelerator(accelerator)
    if (canonical === null) {
      setMessage({
        tone: 'error',
        text: `“${accelerator}” can’t be a shortcut. Use Ctrl, Alt or Win with a key, or a function key.`
      })
      return
    }
    if (canonical === current) {
      setMessage(null)
      return
    }
    setMessage(null)
    pending.current = { candidate: canonical, previous: current }
    useSettingsStore.getState().update({ peekShortcut: canonical })
    // Main always answers a changed shortcut with peek:shortcut; if that got lost, ask.
    fallback.current = setTimeout(() => {
      fallback.current = null
      getBridge()
        .peek.shortcutStatus()
        .then(
          (next) => settleRef.current?.(next),
          (error: unknown) =>
            console.error('settings: asking main for the Peek shortcut failed', error)
        )
    }, STATUS_FALLBACK_MS)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (mode !== 'recording') return
    event.preventDefault()
    event.stopPropagation()
    const read = readShortcut(event)
    if (read.kind === 'partial') setHeld(read.held)
    else if (read.kind === 'cancel') stop()
    else if (read.kind === 'unknown') {
      stop()
      setMessage({ tone: 'error', text: 'Taskyard can’t use that key in a shortcut. Try another.' })
    } else commit(read.accelerator)
  }

  const problem = message?.tone === 'error' ? message.text : statusProblem(status)
  const success = message?.tone === 'ok' ? message.text : ''

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span id={labelId} className="text-[12px] text-text-primary/85">
          Peek shortcut
        </span>
        <button
          type="button"
          aria-labelledby={`${labelId} ${hintId}`}
          aria-describedby={problem ? `${labelId}-problem` : undefined}
          data-recording={mode === 'recording' || undefined}
          onClick={() => {
            setMessage(null)
            setMode((now) => (now === 'recording' ? 'idle' : 'recording'))
          }}
          onKeyDown={onKeyDown}
          onBlur={stop}
          className={cn(
            'flex min-h-7 min-w-[120px] items-center justify-end rounded-[8px] px-2 py-1 text-[11px] transition-colors outline-none',
            'bg-text-primary/5 hover:bg-text-primary/10 focus-visible:ring-2 focus-visible:ring-accent-1',
            mode === 'recording' &&
              'bg-accent-2/20 text-text-primary shadow-[inset_0_0_0_1px_var(--accent-1)]'
          )}
        >
          <span id={hintId} className="sr-only">
            {mode === 'recording'
              ? 'Recording: press the new shortcut, or Esc to cancel'
              : 'Change'}
          </span>
          {mode === 'recording' ? (
            <span aria-hidden="true" className="text-text-secondary">
              {held === '' ? 'Press keys…' : held}
            </span>
          ) : (
            <Keys accelerator={current} />
          )}
        </button>
      </div>
      {problem && (
        <p
          id={`${labelId}-problem`}
          role="alert"
          className="rounded-[8px] bg-red-500/10 px-2.5 py-1.5 text-[11px] leading-snug text-red-700 dark:text-red-200"
        >
          {problem}
        </p>
      )}
      <p
        role="status"
        aria-label="Peek shortcut status"
        className={cn('text-[11px] text-text-tertiary', success === '' && 'sr-only')}
      >
        {success}
      </p>
    </div>
  )
}
