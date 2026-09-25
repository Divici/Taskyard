import { useRef } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { useUiStore } from '../../stores/ui'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  /** A red confirm button; Cancel has the focus either way (Radix AlertDialog). */
  destructive?: boolean
  onConfirm(): void
  onCancel(): void
}

/**
 * A glass confirm dialog (Radix AlertDialog: focus trapped, Cancel focused first, Esc cancels).
 * Used for anything that cannot be undone from Taskyard: deleting a group, trashing files.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element {
  // Radix closes the dialog (onOpenChange(false)) for the action too; only a close that is not
  // the confirm button (Cancel, Esc) cancels.
  const confirmed = useRef(false)
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return
        if (confirmed.current) confirmed.current = false
        else onCancel()
      }}
    >
      <AlertDialogContent className="glass max-w-md rounded-[var(--radius-2)] border-[var(--glass-border)] bg-transparent p-6 text-text-primary shadow-none sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[15px] font-semibold tracking-tight">
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription className="text-[13px] whitespace-pre-line text-text-secondary">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="border-[var(--glass-border)] bg-transparent text-text-primary hover:bg-white/10 focus-visible:ring-accent-1/60">
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            className={
              destructive
                ? 'focus-visible:ring-accent-1/60'
                : 'bg-accent-2 text-white hover:bg-accent-2/90 focus-visible:ring-accent-1/60'
            }
            onClick={() => {
              confirmed.current = true
              onConfirm()
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Renders the pending `useUiStore.confirm()` request (mounted once per window). */
export function ConfirmHost(): React.JSX.Element | null {
  const request = useUiStore((state) => state.confirmRequest)
  const resolve = useUiStore((state) => state.resolveConfirm)
  if (!request) return null
  return (
    <ConfirmDialog
      open
      title={request.title}
      description={request.description}
      confirmLabel={request.confirmLabel}
      destructive={request.destructive}
      onConfirm={() => resolve(true)}
      onCancel={() => resolve(false)}
    />
  )
}
