import { act } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useLayoutStore } from '../../stores/layout'
import { useUiStore } from '../../stores/ui'
import { makeGroup, seedCanvas } from '../../test/canvas-fixtures'
import { installFakeBridge } from '../../test/fake-bridge'
import { shownWindows } from './snap-targets'

// Round 2: what a moving window snaps to while quick-hide is on — only what is still shown.

beforeEach(() => {
  installFakeBridge()
  seedCanvas({
    groups: [
      makeGroup('a', { title: 'Hidden', x: 40 }),
      makeGroup('b', { title: 'Pinned', x: 400, excludeFromQuickHide: true })
    ]
  })
  act(() =>
    useLayoutStore
      .getState()
      .updateTools(1, (tools) => ({ ...tools, visible: true, x: 800, y: 24, w: 320, h: 400 }))
  )
})

const keys = (): string[] => shownWindows(1).map((window) => window.key)

describe('shownWindows under quick-hide', () => {
  it('lists every window while nothing is hidden', () => {
    expect(keys()).toEqual(['group:a', 'group:b', 'tools'])
  })

  it('drops the hidden groups and the tools widget', () => {
    act(() => useUiStore.getState().setQuickHidden(true))
    expect(keys()).toEqual(['group:b'])
  })

  it('keeps the tools widget when it is excluded from quick-hide', () => {
    act(() =>
      useLayoutStore
        .getState()
        .updateTools(1, (tools) => ({ ...tools, excludeFromQuickHide: true }))
    )
    act(() => useUiStore.getState().setQuickHidden(true))
    expect(keys()).toEqual(['group:b', 'tools'])
    expect(shownWindows(1).at(-1)?.rect).toEqual({ x: 800, y: 24, width: 320, height: 400 })
  })
})
