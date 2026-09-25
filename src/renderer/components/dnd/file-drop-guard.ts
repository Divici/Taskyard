const carriesFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files')

/**
 * Chromium's default for a file dropped on a page is to open it in the window, which would
 * navigate a desktop window away from Taskyard (main blocks `will-navigate` too). Only the canvas
 * accepts file drops (useExternalDrop); a file drag anywhere else — a toast, the read-only
 * banner, a dialog or menu portal, the window before its display is known — is swallowed here:
 * no move, and the cursor shows "no drop". Listens on the window in the bubble phase, so the
 * canvas's own handlers (which call preventDefault first) keep their "move". Returns the remover.
 */
export function installFileDropGuard(target: Window): () => void {
  const onDragOver = (event: DragEvent): void => {
    if (!carriesFiles(event) || event.defaultPrevented) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
  }
  const onDrop = (event: DragEvent): void => {
    if (!carriesFiles(event) || event.defaultPrevented) return
    event.preventDefault()
  }
  target.addEventListener('dragover', onDragOver)
  target.addEventListener('drop', onDrop)
  return () => {
    target.removeEventListener('dragover', onDragOver)
    target.removeEventListener('drop', onDrop)
  }
}
