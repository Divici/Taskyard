import { describe, expect, it, vi } from 'vitest'
import { createUiStore, DEFAULT_TOAST_MS, MAX_TOASTS } from './ui'

describe('ui store — toasts', () => {
  it('queues a toast with sensible defaults and returns its id', () => {
    const store = createUiStore()

    const id = store.getState().pushToast({ message: 'Layout saved' })

    expect(store.getState().toasts).toEqual([
      {
        id,
        key: expect.any(Number),
        message: 'Layout saved',
        tone: 'info',
        durationMs: DEFAULT_TOAST_MS
      }
    ])
    expect(DEFAULT_TOAST_MS).toBe(5_000)
  })

  it('keeps toasts in arrival order', () => {
    const store = createUiStore()

    store.getState().pushToast({ message: 'one' })
    store.getState().pushToast({ message: 'two', tone: 'error', durationMs: null })

    expect(store.getState().toasts.map((t) => [t.message, t.tone, t.durationMs])).toEqual([
      ['one', 'info', 5_000],
      ['two', 'error', null]
    ])
  })

  it('replaces a toast pushed again with the same id instead of stacking a duplicate', () => {
    const store = createUiStore()
    store.getState().pushToast({ id: 'recovered:layout', message: 'first' })
    const firstKey = store.getState().toasts[0].key

    store.getState().pushToast({ id: 'recovered:layout', message: 'second' })

    expect(store.getState().toasts).toHaveLength(1)
    expect(store.getState().toasts[0].message).toBe('second')
    expect(store.getState().toasts[0].key).not.toBe(firstKey)
  })

  it('drops the oldest toast beyond the limit', () => {
    const store = createUiStore()

    for (let n = 1; n <= MAX_TOASTS + 1; n++) store.getState().pushToast({ message: `t${n}` })

    expect(store.getState().toasts.map((t) => t.message)).toEqual(['t2', 't3', 't4', 't5', 't6'])
  })

  it('dismisses by id', () => {
    const store = createUiStore()
    const keep = store.getState().pushToast({ message: 'keep' })
    const drop = store.getState().pushToast({ message: 'drop' })

    store.getState().dismissToast(drop)
    store.getState().dismissToast('unknown')

    expect(store.getState().toasts.map((t) => t.id)).toEqual([keep])
  })

  it('keeps an action with the toast', () => {
    const store = createUiStore()
    const onAction = vi.fn()

    store.getState().pushToast({ message: 'Moved 3 files', action: { label: 'Undo', onAction } })

    expect(store.getState().toasts[0].action).toEqual({ label: 'Undo', onAction })
  })
})

describe('ui store — read-only files', () => {
  it('records which data files are read-only', () => {
    const store = createUiStore()

    store.getState().setReadOnly([{ store: 'layout', reason: 'future-version', version: 2 }])

    expect(store.getState().readOnly).toEqual([
      { store: 'layout', reason: 'future-version', version: 2 }
    ])
  })
})
