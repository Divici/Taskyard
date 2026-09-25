import type { ShortcutStatus } from '@shared/ipc'
import type { TaskyardApi } from '../../preload/api'
import { useDisplayStore } from '../stores/display'
import { useUiStore } from '../stores/ui'
import { setQuickHide } from './quick-hide'

// Peek in a window (Phase 9). Main owns Peek (window manager + src/main/app/shortcuts.ts); this
// window pulls the state when it loads (`peek:get`), and while a Peek is on it reports what only
// the page can see: a text input gaining or losing focus (the 8 s idle unpeek waits), activity
// (restarts it) and a left click outside every group and panel (ends the Peek).

/** Activity is reported at most this often: the idle timer only needs a restart now and then. */
export const ACTIVITY_THROTTLE_MS = 1_000

/**
 * What a click may land on without ending the Peek: groups, icons, menus, dialogs, and any panel
 * marked `data-peek-keep` (toasts, the read-only banner, the empty-desktop hint; Phase 10's tools
 * widget and Phase 11's inspector add it too). Everything else is the empty desktop.
 */
export const PEEK_KEEP_SELECTOR = [
  '[data-group-id]',
  '[data-item-id]',
  '[data-peek-keep]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="alertdialog"]'
].join(', ')

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number'])

/** A field that takes typing: text-like inputs, text areas and editable content. */
export function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type) && !target.readOnly && !target.disabled
  }
  // `=== true`: jsdom leaves isContentEditable undefined.
  return target.isContentEditable === true
}

const SHORTCUT_TOAST = 'peek-shortcut'

/** The toast for a Peek shortcut main could not register (null: it is fine). */
function shortcutToast(status: ShortcutStatus): { message: string } | null {
  if (status.error === null) return null
  if (status.error === 'invalid') {
    const still =
      status.active === null ? 'Peek has no shortcut.' : `Peek still uses ${status.active}.`
    return { message: `“${status.accelerator}” isn’t a valid shortcut. ${still}` }
  }
  return {
    message:
      status.active === null
        ? `${status.accelerator} is already used by another app, so Peek has no shortcut.`
        : `${status.accelerator} is already used by another app. Peek still uses ${status.active}.`
  }
}

function showShortcutStatus(status: ShortcutStatus): void {
  const ui = useUiStore.getState()
  const toast = shortcutToast(status)
  if (toast === null) {
    ui.dismissToast(SHORTCUT_TOAST)
    return
  }
  ui.pushToast({
    id: SHORTCUT_TOAST,
    tone: 'error',
    message: toast.message,
    description: 'Choose another shortcut for Peek in Settings.',
    durationMs: null
  })
}

/**
 * Connects this window to main's Peek. Returns the disconnect (listeners removed, late answers
 * ignored).
 */
export function connectPeek(
  api: Pick<TaskyardApi, 'peek' | 'on'>,
  doc: Document = document
): () => void {
  let connected = true
  let peekSeen = false
  /** The last input-focus state sent to main. */
  let typing = false
  let lastActivity = Number.NEGATIVE_INFINITY

  const peeking = (): boolean => useDisplayStore.getState().peeking
  const report = (promise: Promise<unknown>, what: string): void => {
    promise.catch((error: unknown) => console.error(`peek: ${what} failed`, error))
  }

  /** Always sent (never deduped): main may have dropped this window's pause meanwhile. */
  const reportTyping = (focused: boolean): void => {
    typing = focused
    report(api.peek.inputFocus(focused), 'reporting input focus')
  }
  /** Focus moved: tell main only when typing starts or stops. */
  const sendTyping = (focused: boolean): void => {
    if (focused !== typing) reportTyping(focused)
  }
  /** A Peek is on (event, or the pull after a (re)load): say whether this window is typing. */
  const peekStarted = (): void => {
    reportTyping(isTextInput(doc.activeElement))
    lastActivity = Number.NEGATIVE_INFINITY
  }

  const activity = (): void => {
    const now = Date.now()
    if (now - lastActivity < ACTIVITY_THROTTLE_MS) return
    lastActivity = now
    report(api.peek.activity(), 'reporting activity')
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (!peeking()) return
    const target = event.target instanceof Element ? event.target : null
    const kept = target?.closest(PEEK_KEEP_SELECTOR) != null
    // Only a left click on the empty desktop leaves the Peek; a right click opens the desktop menu.
    if (event.button === 0 && !kept) {
      report(api.peek.clickOutside(), 'ending the Peek')
      return
    }
    activity()
  }
  const onActivity = (): void => {
    if (peeking()) activity()
  }
  const onFocusIn = (event: FocusEvent): void => {
    if (peeking()) sendTyping(isTextInput(event.target))
  }
  const onFocusOut = (event: FocusEvent): void => {
    if (peeking()) sendTyping(isTextInput(event.relatedTarget))
  }

  const offPeek = api.on('peek:changed', ({ peeking: on }) => {
    peekSeen = true
    // display-sync mirrors it too; set here as well so the handlers below never read it stale.
    useDisplayStore.getState().setPeeking(on)
    if (!on) {
      // Main dropped every pause with the Peek.
      typing = false
      return
    }
    peekStarted()
    // Peek shows the groups: a quick-hidden desktop comes back.
    if (useUiStore.getState().quickHidden) setQuickHide(false)
  })
  const offShortcut = api.on('peek:shortcut', showShortcutStatus)

  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('keydown', onActivity, true)
  doc.addEventListener('wheel', onActivity, { capture: true, passive: true })
  doc.addEventListener('focusin', onFocusIn)
  doc.addEventListener('focusout', onFocusOut)

  api.peek.get().then(
    (state) => {
      if (!connected || peekSeen) return
      useDisplayStore.getState().setPeeking(state.peeking)
      if (state.peeking) peekStarted()
    },
    (error: unknown) => console.error('peek: asking main for the state failed', error)
  )
  api.peek.shortcutStatus().then(
    (status) => {
      if (connected) showShortcutStatus(status)
    },
    (error: unknown) => console.error('peek: asking main for the shortcut failed', error)
  )

  return () => {
    connected = false
    offPeek()
    offShortcut()
    doc.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('keydown', onActivity, true)
    doc.removeEventListener('wheel', onActivity, true)
    doc.removeEventListener('focusin', onFocusIn)
    doc.removeEventListener('focusout', onFocusOut)
  }
}
