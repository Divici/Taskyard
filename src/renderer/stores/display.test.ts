import { describe, expect, it } from 'vitest'
import type { DisplayInfo } from '@shared/ipc'
import { resetStores } from '../test/reset-stores'
import { createDisplayStore, useDisplayStore } from './display'

const SECONDARY: DisplayInfo = {
  id: 1529295726,
  bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
  workArea: { x: 2560, y: 0, width: 1920, height: 1032 },
  scaleFactor: 1.5
}

describe('display store', () => {
  it('starts knowing nothing about its display and not peeking', () => {
    expect(createDisplayStore().getState()).toMatchObject({
      displayId: null,
      info: null,
      peeking: false,
      problem: null
    })
  })

  it('keeps a copy of the display main sent, so later changes to the argument cannot leak in', () => {
    const store = createDisplayStore()
    const sent = structuredClone(SECONDARY)

    store.getState().receiveInfo(sent)
    sent.bounds.width = 1

    expect(store.getState().info).toEqual(SECONDARY)
  })

  it('clears a reported problem once the display arrives', () => {
    const store = createDisplayStore()
    store.getState().reportProblem('fetch-failed')

    store.getState().receiveInfo(SECONDARY)

    expect(store.getState().problem).toBeNull()
  })

  it('records the display id from the URL and the peek state', () => {
    const store = createDisplayStore()

    store.getState().setDisplayId(SECONDARY.id)
    store.getState().setPeeking(true)

    expect(store.getState()).toMatchObject({ displayId: SECONDARY.id, peeking: true })
  })

  it('is put back to its initial state by the shared test reset', () => {
    useDisplayStore.getState().receiveInfo(SECONDARY)
    useDisplayStore.getState().setPeeking(true)

    resetStores()

    expect(useDisplayStore.getState()).toMatchObject({ info: null, peeking: false })
  })
})
