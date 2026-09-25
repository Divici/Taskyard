// Keyboard model for desktop items (Explorer's keys), shared by group bodies and the loose
// layer: which action a key means, and which item an arrow key lands on. Pure; the list hook
// (components/icon/useItemList.ts) performs the actions.

export type Direction = 'left' | 'right' | 'up' | 'down'

export type ItemKeyAction =
  | { type: 'move'; direction: Direction }
  | { type: 'open' }
  | { type: 'rename' }
  | { type: 'trash' }
  | { type: 'clear' }
  | { type: 'selectAll' }

export type KeyInput = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>

const ARROWS: Readonly<Record<string, Direction>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}

/**
 * Arrows move the selection, Enter opens, F2 renames, Delete trashes, Esc clears, Ctrl+A selects
 * all; null for anything else (so the key keeps its default behaviour).
 */
export function itemKeyAction(event: KeyInput): ItemKeyAction | null {
  const ctrl = event.ctrlKey || event.metaKey
  if (event.altKey) return null
  if (ctrl) return event.key.toLowerCase() === 'a' && !event.shiftKey ? { type: 'selectAll' } : null
  const direction = ARROWS[event.key]
  if (direction) return { type: 'move', direction }
  switch (event.key) {
    case 'Enter':
      return { type: 'open' }
    case 'F2':
      return { type: 'rename' }
    case 'Delete':
      return { type: 'trash' }
    case 'Escape':
      return { type: 'clear' }
    default:
      return null
  }
}

/**
 * The item an arrow lands on in a grid laid out row by row, `columns` wide; null at an edge.
 * With nothing focused yet, any arrow lands on the first item.
 */
export function gridNeighbor(
  ids: readonly string[],
  current: string | null,
  direction: Direction,
  columns: number
): string | null {
  if (ids.length === 0) return null
  const index = current === null ? -1 : ids.indexOf(current)
  if (index === -1) return ids[0]
  const last = ids.length - 1
  switch (direction) {
    case 'left':
      return index % columns === 0 ? null : ids[index - 1]
    case 'right':
      return index % columns === columns - 1 || index === last ? null : ids[index + 1]
    case 'up':
      return index - columns < 0 ? null : ids[index - columns]
    case 'down': {
      if (index + columns <= last) return ids[index + columns]
      // Into a shorter last row: its last item (if that row is below this one).
      const row = Math.floor(index / columns)
      return Math.floor(last / columns) > row ? ids[last] : null
    }
  }
}

export interface PositionedId {
  id: string
  x: number
  y: number
}

/**
 * For free-floating icons: the nearest icon whose position lies in the pressed direction (a 90°
 * cone around the axis), preferring icons close to the axis. Null when there is none.
 */
export function spatialNeighbor(
  points: readonly PositionedId[],
  current: string | null,
  direction: Direction
): string | null {
  const from = points.find((point) => point.id === current)
  if (!from) return points[0]?.id ?? null
  let best: { id: string; score: number } | null = null
  for (const point of points) {
    if (point.id === from.id) continue
    const dx = point.x - from.x
    const dy = point.y - from.y
    const [along, across] =
      direction === 'left'
        ? [-dx, dy]
        : direction === 'right'
          ? [dx, dy]
          : direction === 'up'
            ? [-dy, dx]
            : [dy, dx]
    if (along <= 0 || Math.abs(across) > along) continue
    const score = along + Math.abs(across) * 2
    if (best === null || score < best.score) best = { id: point.id, score }
  }
  return best?.id ?? null
}
