import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import App from '../../App'
import { useTasksStore } from '../../stores/tasks'
import { useUiStore } from '../../stores/ui'
import { installFakeBridge } from '../../test/fake-bridge'
import { installFileDropGuard } from './file-drop-guard'

/** A native file drag event (jsdom has no DragEvent); returns it after dispatch. */
function fileDrag(target: EventTarget, type: 'dragover' | 'drop', types = ['Files']): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
  const path = 'D:\\Photos\\a.jpg'
  const dataTransfer = {
    types,
    files: [Object.assign(new File(['x'], 'a.jpg'), { path })],
    dropEffect: 'copy'
  }
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

const effect = (event: Event): string =>
  (event as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect

beforeEach(() => {
  window.history.replaceState(null, '', '/?displayId=1')
})

describe('installFileDropGuard', () => {
  it('swallows a file drop the page did not handle (Chromium would open the file in the window)', () => {
    const element = document.createElement('div')
    document.body.append(element)
    const remove = installFileDropGuard(window)

    const over = fileDrag(element, 'dragover')
    expect(over.defaultPrevented).toBe(true)
    expect(effect(over)).toBe('none') // the cursor says "no drop here"
    expect(fileDrag(element, 'drop').defaultPrevented).toBe(true)
    // Other drags (text, links inside the page) are left alone.
    expect(fileDrag(element, 'drop', ['text/plain']).defaultPrevented).toBe(false)

    remove()
    expect(fileDrag(element, 'drop').defaultPrevented).toBe(false)
  })

  it('in the app: a file dropped on the Undo toast is swallowed and moves nothing; the canvas still takes drops', async () => {
    const bridge = installFakeBridge()
    render(<App />)
    await waitFor(() => expect(useTasksStore.getState().hydrated).toBe(true))
    act(() => {
      useUiStore.getState().pushToast({
        message: 'Moved 1 item to the Desktop',
        action: { label: 'Undo', onAction: () => {} }
      })
    })
    const undo = await screen.findByRole('button', { name: 'Undo' })

    const over = fileDrag(undo, 'dragover')
    const drop = fileDrag(undo, 'drop')

    expect(over.defaultPrevented).toBe(true)
    expect(effect(over)).toBe('none')
    expect(drop.defaultPrevented).toBe(true)
    expect(bridge.desktop.moveToDesktop).not.toHaveBeenCalled()

    // The canvas handles its own drops (and says "move").
    const surface = await waitFor(() => {
      const found = document.querySelector('[data-canvas-surface]')
      expect(found).not.toBeNull()
      return found!
    })
    expect(effect(fileDrag(surface, 'dragover'))).toBe('move')
    fileDrag(surface, 'drop')
    await waitFor(() => expect(bridge.desktop.moveToDesktop).toHaveBeenCalledOnce())
  })
})
