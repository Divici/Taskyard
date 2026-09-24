import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { ReadOnlyInfo } from '@shared/ipc'

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

export interface ToastAction {
  label: string
  onAction: () => void
}

export interface Toast {
  /** Stable identity: pushing the same id again replaces the toast instead of stacking it. */
  id: string
  /** Changes on every push, so a replaced toast restarts its timer. */
  key: number
  message: string
  description?: string
  tone: ToastTone
  /** Auto-dismiss delay; `null` keeps the toast until the user dismisses it. */
  durationMs: number | null
  action?: ToastAction
}

export interface ToastInput {
  id?: string
  message: string
  description?: string
  tone?: ToastTone
  durationMs?: number | null
  action?: ToastAction
}

export const DEFAULT_TOAST_MS = 5_000
/** Older toasts beyond this are dropped. */
export const MAX_TOASTS = 5

export interface UiState {
  toasts: Toast[]
  /** Data files main will not overwrite this session (drives the read-only banner). */
  readOnly: ReadOnlyInfo[]
  pushToast(input: ToastInput): string
  dismissToast(id: string): void
  setReadOnly(readOnly: ReadOnlyInfo[]): void
}

let nextToast = 0

function sameReadOnly(a: readonly ReadOnlyInfo[], b: readonly ReadOnlyInfo[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, index) =>
        entry.store === b[index].store &&
        entry.reason === b[index].reason &&
        entry.version === b[index].version
    )
  )
}

/** Transient UI state. Phase 7 adds selection, marquee, quick-hide and the inspector here. */
export function createUiStore(): UseBoundStore<StoreApi<UiState>> {
  return create<UiState>()((set) => ({
    toasts: [],
    readOnly: [],

    pushToast(input) {
      nextToast += 1
      const toast: Toast = {
        id: input.id ?? `toast-${nextToast}`,
        key: nextToast,
        message: input.message,
        tone: input.tone ?? 'info',
        durationMs: input.durationMs === undefined ? DEFAULT_TOAST_MS : input.durationMs
      }
      if (input.description !== undefined) toast.description = input.description
      if (input.action !== undefined) toast.action = input.action

      set(({ toasts }) => {
        const index = toasts.findIndex((existing) => existing.id === toast.id)
        const next =
          index === -1 ? [...toasts, toast] : toasts.map((t, i) => (i === index ? toast : t))
        return { toasts: next.slice(-MAX_TOASTS) }
      })
      return toast.id
    },

    dismissToast(id) {
      set(({ toasts }) =>
        toasts.some((toast) => toast.id === id)
          ? { toasts: toasts.filter((toast) => toast.id !== id) }
          : {}
      )
    },

    setReadOnly(readOnly) {
      set((state) => (sameReadOnly(state.readOnly, readOnly) ? {} : { readOnly: [...readOnly] }))
    }
  }))
}

export const useUiStore = createUiStore()
