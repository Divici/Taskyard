import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { ReadOnlyInfo } from '@shared/ipc'
import type { Rect } from '@shared/schema'

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

/** What is being renamed inline: a desktop item (by file id) or a group's title. */
export interface RenameTarget {
  kind: 'item' | 'group'
  id: string
}

export interface ConfirmInput {
  title: string
  description: string
  /** The confirm button's label ("OK" when omitted). */
  confirmLabel?: string
  /** Red confirm button (delete, trash). */
  destructive?: boolean
}

export interface ConfirmRequest extends Required<ConfirmInput> {
  resolve(ok: boolean): void
}

export interface UiState {
  toasts: Toast[]
  /** Data files main will not overwrite this session (drives the read-only banner). */
  readOnly: ReadOnlyInfo[]
  pushToast(input: ToastInput): string
  dismissToast(id: string): void
  setReadOnly(readOnly: ReadOnlyInfo[]): void

  // ---- Phase 7: selection and canvas state (per window, never persisted) --------------------

  /** Selected item ids (file ids), in the order they were selected. */
  selection: string[]
  /** Where a shift+click range starts: the last id clicked or toggled. */
  selectionAnchor: string | null
  /** The rubber band being dragged on the canvas (window coordinates), or null. */
  marquee: Rect | null
  /** Double-click on the empty desktop hides the icons and groups (not persisted). */
  quickHidden: boolean
  /** The settings inspector (Phase 11 renders it; the canvas menu opens it). */
  inspectorOpen: boolean
  /** The item or group title being renamed inline, or null. */
  renaming: RenameTarget | null
  /** The pending confirm dialog (ConfirmHost renders it), or null. */
  confirmRequest: ConfirmRequest | null
  /** The empty-desktop hint card was closed this session. */
  hintDismissed: boolean
  /** Replaces the selection; the anchor becomes `anchor` (default: the last id). */
  select(ids: string[], anchor?: string | null): void
  /** Ctrl+click: adds or removes one id and makes it the anchor. */
  toggleSelect(id: string): void
  /** Shift+click: selects `ordered` from the anchor to `to` (just `to` without an anchor). */
  selectRange(ordered: readonly string[], to: string): void
  clearSelection(): void
  setMarquee(marquee: Rect | null): void
  setQuickHidden(hidden: boolean): void
  toggleQuickHidden(): void
  setInspectorOpen(open: boolean): void
  startRename(target: RenameTarget): void
  stopRename(): void
  /** Asks the user; resolves true on confirm, false on cancel (or when replaced by another). */
  confirm(input: ConfirmInput): Promise<boolean>
  /** Answers the pending confirm (ConfirmHost calls it). */
  resolveConfirm(ok: boolean): void
  dismissHint(): void
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
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

/** Transient UI state: toasts, the read-only banner, selection and canvas state. */
export function createUiStore(): UseBoundStore<StoreApi<UiState>> {
  return create<UiState>()((set, get) => ({
    toasts: [],
    readOnly: [],
    selection: [],
    selectionAnchor: null,
    marquee: null,
    quickHidden: false,
    inspectorOpen: false,
    renaming: null,
    confirmRequest: null,
    hintDismissed: false,

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
    },

    select(ids, anchor) {
      const nextAnchor = anchor === undefined ? (ids.at(-1) ?? null) : anchor
      set((state) =>
        sameIds(state.selection, ids) && state.selectionAnchor === nextAnchor
          ? state
          : { selection: [...ids], selectionAnchor: nextAnchor }
      )
    },

    toggleSelect(id) {
      set((state) => ({
        selection: state.selection.includes(id)
          ? state.selection.filter((selected) => selected !== id)
          : [...state.selection, id],
        selectionAnchor: id
      }))
    },

    selectRange(ordered, to) {
      const { selectionAnchor } = get()
      const from = selectionAnchor === null ? -1 : ordered.indexOf(selectionAnchor)
      const end = ordered.indexOf(to)
      if (from === -1 || end === -1) {
        get().select([to])
        return
      }
      const range = ordered.slice(Math.min(from, end), Math.max(from, end) + 1)
      set((state) => (sameIds(state.selection, range) ? state : { selection: range }))
    },

    clearSelection() {
      set((state) =>
        state.selection.length === 0 && state.selectionAnchor === null
          ? state
          : { selection: [], selectionAnchor: null }
      )
    },

    setMarquee: (marquee) => set({ marquee }),
    setQuickHidden: (quickHidden) => set({ quickHidden }),
    toggleQuickHidden: () => set((state) => ({ quickHidden: !state.quickHidden })),
    setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
    startRename: (renaming) => set({ renaming: { ...renaming } }),
    stopRename: () => set({ renaming: null }),

    confirm(input) {
      get().confirmRequest?.resolve(false)
      return new Promise<boolean>((resolve) => {
        set({
          confirmRequest: {
            title: input.title,
            description: input.description,
            confirmLabel: input.confirmLabel ?? 'OK',
            destructive: input.destructive ?? false,
            resolve
          }
        })
      })
    },

    resolveConfirm(ok) {
      const request = get().confirmRequest
      if (!request) return
      set({ confirmRequest: null })
      request.resolve(ok)
    },

    dismissHint: () => set({ hintDismissed: true })
  }))
}

export const useUiStore = createUiStore()
