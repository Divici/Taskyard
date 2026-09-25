import {
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  type Activators,
  type KeyboardSensorOptions,
  type PointerSensorOptions,
  type PointerSensorProps
} from '@dnd-kit/core'
import type { PointerEvent as ReactPointerEvent } from 'react'

/** Presses on these never start an item drag (typing, clicking a control). */
const INTERACTIVE = 'input, textarea, select, button, [contenteditable], [data-no-dnd]'

function fromInteractive(event: Event): boolean {
  const target = event.target
  return target instanceof Element && target.closest(INTERACTIVE) !== null
}

/** The pointer sensor of the drag in progress (dnd-kit creates one per press). */
let current: DesktopPointerSensor | null = null

/**
 * dnd-kit's PointerSensor (LOCKED Decision 8: `distance: 6`, so clicks and double-clicks stay
 * clicks) that ignores presses on inputs and buttons, and can be cancelled from outside:
 * `cancelActivePointerDrag` ends the drag as Escape would (drag-out hands the files to the OS
 * drag only after this).
 */
export class DesktopPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: (event: ReactPointerEvent, options: PointerSensorOptions): boolean =>
        !fromInteractive(event.nativeEvent) && PointerSensor.activators[0].handler(event, options)
    }
  ]

  constructor(props: PointerSensorProps) {
    super(props)
    // The sensor of the press in progress, so drag-out can cancel it.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    current = this
  }
}

/**
 * Cancels the pointer drag in progress (its `onDragCancel` runs, so the overlay and the drop hint
 * clear). False when there is none.
 */
export function cancelActivePointerDrag(): boolean {
  const sensor = current
  current = null
  if (sensor === null) return false
  // `handleCancel` is private in dnd-kit's typings; it is the bound method Escape calls.
  ;(sensor as unknown as { handleCancel(): void }).handleCancel()
  return true
}

/**
 * Keyboard drags: Space picks an icon up (Enter stays "open"), arrows move it, Space or Enter
 * drops, Escape cancels. Keys typed into an input (inline rename) never start a drag.
 */
export class DesktopKeyboardSensor extends KeyboardSensor {
  static activators: Activators<KeyboardSensorOptions> = [
    {
      eventName: 'onKeyDown',
      handler: (event: React.KeyboardEvent, options, context) =>
        !fromInteractive(event.nativeEvent) &&
        KeyboardSensor.activators[0].handler(event, options, context)
    }
  ]
}

export const KEYBOARD_CODES: KeyboardSensorOptions['keyboardCodes'] = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter]
}
