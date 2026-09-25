import { act, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { MoveToDesktopResult } from '@shared/ipc'
import { useLayoutStore } from '../../stores/layout'
import { useUiStore } from '../../stores/ui'
import { desktopItem, makeGroup } from '../../test/canvas-fixtures'
import { mockRect } from '../../test/dnd-rects'
import { NOTES, renderDesktop } from './dnd-test-utils'
import { UNDO_DROP_MS } from './dnd-types'

/** Files as Explorer hands them over; the fake bridge's pathForFile reads `path`. */
function files(...paths: string[]): File[] {
  return paths.map((path) => Object.assign(new File(['x'], path.split('\\').pop()!), { path }))
}

/**
 * jsdom has no DragEvent: a MouseEvent carries the pointer position, `dataTransfer` is set on it.
 * Returns whether the page accepted the event (preventDefault).
 */
function nativeDrag(
  target: Element,
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  point: { x: number; y: number },
  dropped: File[] = [],
  types: string[] = ['Files']
): { accepted: boolean; dropEffect: string } {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y
  })
  const dataTransfer = { types, files: dropped, dropEffect: 'none' }
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  act(() => {
    target.dispatchEvent(event)
  })
  return { accepted: event.defaultPrevented, dropEffect: dataTransfer.dropEffect }
}

const surface = (): Element => document.querySelector('[data-canvas-surface]')!
const display = (): ReturnType<typeof useLayoutStore.getState>['layout']['displays'][number] =>
  useLayoutStore.getState().layout.displays[0]
const lastToast = (): ReturnType<typeof useUiStore.getState>['toasts'][number] =>
  useUiStore.getState().toasts.at(-1)!

describe('useExternalDrop', () => {
  it('places a path that is already on the desktop without moving it; Undo puts it back', async () => {
    const { bridge } = renderDesktop()

    // Explorer may report a different case than the scan: NTFS paths compare case-insensitively.
    nativeDrag(surface(), 'drop', { x: 300, y: 300 }, files(NOTES.path.toUpperCase()))

    await waitFor(() => expect(display().loose).toEqual({ '1:1': { x: 288, y: 288 } }))
    expect(bridge.desktop.moveToDesktop).not.toHaveBeenCalled()
    expect(lastToast()).toMatchObject({ message: 'Placed 1 item', durationMs: UNDO_DROP_MS })

    act(() => lastToast().action!.onAction())

    await waitFor(() => expect(display().loose).toEqual({ '1:1': { x: 0, y: 0 } }))
    expect(bridge.desktop.undoMove).not.toHaveBeenCalled()
  })

  it('moves other paths into the Desktop (moveToDesktop), then places them at the drop point; per-file failures are reported', async () => {
    const { bridge } = renderDesktop()
    const result: MoveToDesktopResult = {
      moves: [
        {
          from: 'D:\\Photos\\a.jpg',
          ok: true,
          id: '7:1',
          path: 'C:\\Users\\me\\Desktop\\a.jpg',
          token: 'op-1'
        },
        { from: 'E:\\Share\\locked.txt', ok: false, code: 'permission', message: 'EPERM' },
        {
          from: 'D:\\Photos\\b.jpg',
          ok: true,
          id: '7:2',
          path: 'C:\\Users\\me\\Desktop\\b.jpg',
          token: 'op-2'
        }
      ]
    }
    bridge.desktop.moveToDesktop.mockResolvedValue(result)

    const over = nativeDrag(surface(), 'dragover', { x: 300, y: 300 })
    expect(over).toEqual({ accepted: true, dropEffect: 'move' })
    expect(useUiStore.getState().dropHint).toEqual({ kind: 'canvas', point: { x: 288, y: 288 } })
    nativeDrag(
      surface(),
      'drop',
      { x: 300, y: 300 },
      files('D:\\Photos\\a.jpg', 'E:\\Share\\locked.txt', 'D:\\Photos\\b.jpg')
    )

    await waitFor(() =>
      expect(display().loose).toEqual({
        '1:1': { x: 0, y: 0 },
        '7:1': { x: 288, y: 288 },
        '7:2': { x: 288, y: 384 }
      })
    )
    expect(bridge.desktop.moveToDesktop).toHaveBeenCalledExactlyOnceWith([
      'D:\\Photos\\a.jpg',
      'E:\\Share\\locked.txt',
      'D:\\Photos\\b.jpg'
    ])
    expect(useUiStore.getState().dropHint).toBeNull()
    const toasts = useUiStore.getState().toasts
    expect(toasts).toEqual([
      expect.objectContaining({
        tone: 'error',
        message: '1 item couldn’t be moved to the Desktop',
        description: 'locked.txt: Windows denied access.'
      }),
      expect.objectContaining({ message: 'Moved 2 items to the Desktop', durationMs: UNDO_DROP_MS })
    ])
  })

  it('Undo moves the files back (undoMove per file) and removes their placement', async () => {
    const { bridge } = renderDesktop()
    bridge.desktop.moveToDesktop.mockResolvedValue({
      moves: [
        {
          from: 'D:\\a.txt',
          ok: true,
          id: '7:1',
          path: 'C:\\Users\\me\\Desktop\\a.txt',
          token: 'op-1'
        }
      ]
    })
    nativeDrag(surface(), 'drop', { x: 300, y: 300 }, files('D:\\a.txt'))
    await waitFor(() => expect(display().loose['7:1']).toEqual({ x: 288, y: 288 }))

    act(() => lastToast().action!.onAction())

    await waitFor(() => expect(display().loose).toEqual({ '1:1': { x: 0, y: 0 } }))
    expect(bridge.desktop.undoMove).toHaveBeenCalledExactlyOnceWith('op-1')
  })

  it('drops into a group before the icon under the pointer', async () => {
    const plan = desktopItem('1:2', 'Plan')
    const code = desktopItem('1:3', 'Code')
    const { bridge } = renderDesktop({
      items: [NOTES, plan, code],
      groups: [makeGroup('a', { items: ['1:2', '1:3'], x: 400, y: 40 })]
    })
    const body = document.querySelector('[data-group-body="a"]')!
    mockRect(body, { x: 400, y: 76, width: 256, height: 160 })
    bridge.desktop.moveToDesktop.mockResolvedValue({
      moves: [
        {
          from: 'D:\\a.txt',
          ok: true,
          id: '7:1',
          path: 'C:\\Users\\me\\Desktop\\a.txt',
          token: 'op-1'
        }
      ]
    })

    // Over "Code" (the second cell), left half.
    const code_ = document.querySelector('[data-item-id="1:3"]')!
    nativeDrag(code_, 'dragover', { x: 492, y: 100 })
    expect(useUiStore.getState().dropHint).toEqual({ kind: 'group', groupId: 'a', index: 1 })
    nativeDrag(code_, 'drop', { x: 492, y: 100 }, files('D:\\a.txt'))

    await waitFor(() => expect(display().groups[0].items).toEqual(['1:2', '7:1', '1:3']))
  })

  it('ignores drags that carry no files and clears the hint when the drag leaves the window', () => {
    renderDesktop()

    expect(nativeDrag(surface(), 'dragover', { x: 300, y: 300 }, [], ['text/plain']).accepted).toBe(
      false
    )
    expect(useUiStore.getState().dropHint).toBeNull()

    nativeDrag(surface(), 'dragover', { x: 300, y: 300 })
    expect(useUiStore.getState().dropHint).not.toBeNull()
    nativeDrag(surface(), 'dragleave', { x: -1, y: 300 })
    expect(useUiStore.getState().dropHint).toBeNull()
  })
})
