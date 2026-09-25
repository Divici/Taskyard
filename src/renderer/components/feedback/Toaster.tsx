import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUiStore, type Toast, type ToastTone } from '../../stores/ui'

const TONES: Record<ToastTone, { icon: LucideIcon; accent: string }> = {
  info: { icon: Info, accent: 'border-l-sky-500 text-sky-600 dark:text-sky-400' },
  success: {
    icon: CircleCheck,
    accent: 'border-l-emerald-500 text-emerald-600 dark:text-emerald-400'
  },
  warning: { icon: TriangleAlert, accent: 'border-l-amber-500 text-amber-600 dark:text-amber-400' },
  error: { icon: CircleAlert, accent: 'border-l-red-500 text-red-600 dark:text-red-400' }
}

/**
 * Calls `onExpire` after `durationMs` of *unpaused* time. Pausing keeps the time left, so a toast
 * the user is reading or focusing never disappears under them (WCAG 2.2.1, timing adjustable).
 */
function useAutoDismiss(durationMs: number | null, paused: boolean, onExpire: () => void): void {
  const remaining = useRef(durationMs)
  const expire = useRef(onExpire)

  useEffect(() => {
    expire.current = onExpire
  })

  useEffect(() => {
    if (remaining.current === null || paused) return
    const started = Date.now()
    const timer = setTimeout(() => expire.current(), remaining.current)
    return () => {
      clearTimeout(timer)
      if (remaining.current !== null) {
        remaining.current = Math.max(0, remaining.current - (Date.now() - started))
      }
    }
  }, [paused])
}

function ToastView({
  toast,
  onDismiss
}: {
  toast: Toast
  onDismiss: (id: string) => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const dismiss = (): void => onDismiss(toast.id)
  useAutoDismiss(toast.durationMs, hovered || focused, dismiss)

  const { icon: Icon, accent } = TONES[toast.tone]

  const onBlur = (event: FocusEvent<HTMLLIElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      dismiss()
    }
  }

  return (
    <li
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-lg border border-l-4 bg-popover px-4 py-3',
        'text-sm text-popover-foreground shadow-lg',
        accent
      )}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 text-popover-foreground">
        <p className="font-medium">{toast.message}</p>
        {toast.description && (
          <p className="mt-0.5 whitespace-pre-line text-muted-foreground">{toast.description}</p>
        )}
      </div>
      {toast.action && (
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 font-medium text-popover-foreground underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => {
            toast.action?.onAction()
            dismiss()
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss notification"
        className="-mr-1 shrink-0 rounded-md p-1 text-muted-foreground hover:text-popover-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={dismiss}
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </li>
  )
}

/**
 * Renders the ui store's toast queue. The polite status region is always mounted, so screen
 * readers announce a toast when it is added (not only the ones present at load).
 */
export function Toaster(): React.JSX.Element {
  const toasts = useUiStore((state) => state.toasts)
  const dismissToast = useUiStore((state) => state.dismissToast)

  return (
    <section
      aria-label="Notifications"
      // A click on a toast is not a click on the desktop: it does not end a Peek.
      data-peek-keep=""
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2"
    >
      <div role="status" aria-live="polite" aria-atomic="false" aria-relevant="additions text">
        {toasts.length > 0 && (
          <ol className="flex flex-col gap-2">
            {toasts.map((toast) => (
              <ToastView key={toast.key} toast={toast} onDismiss={dismissToast} />
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}
