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

describe('ui store — selection', () => {
  it('replaces, toggles and clears the selection, keeping the anchor', () => {
    const store = createUiStore()
    const ui = (): ReturnType<typeof store.getState> => store.getState()

    ui().select(['a'])
    expect(ui().selection).toEqual(['a'])
    expect(ui().selectionAnchor).toBe('a')

    ui().toggleSelect('b')
    expect(ui().selection).toEqual(['a', 'b'])
    expect(ui().selectionAnchor).toBe('b')
    ui().toggleSelect('a')
    expect(ui().selection).toEqual(['b'])

    ui().clearSelection()
    expect(ui().selection).toEqual([])
    expect(ui().selectionAnchor).toBeNull()
  })

  it('selects a range between the anchor and the clicked id, in display order', () => {
    const store = createUiStore()
    const order = ['a', 'b', 'c', 'd', 'e']

    store.getState().select(['d'])
    store.getState().selectRange(order, 'b')
    expect(store.getState().selection).toEqual(['b', 'c', 'd'])
    // The anchor stays, so another shift+click re-spans from it.
    store.getState().selectRange(order, 'e')
    expect(store.getState().selection).toEqual(['d', 'e'])
  })

  it('selects only the clicked id when there is no anchor in the list', () => {
    const store = createUiStore()
    store.getState().selectRange(['a', 'b'], 'b')
    expect(store.getState().selection).toEqual(['b'])
  })

  it('does not notify subscribers when the selection is unchanged', () => {
    const store = createUiStore()
    store.getState().select(['a'])
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.getState().select(['a'])
    store.getState().clearSelection()
    store.getState().clearSelection()
    unsubscribe()
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('ui store — canvas state', () => {
  it('tracks the marquee, quick-hide, the inspector and inline rename', () => {
    const store = createUiStore()
    const ui = (): ReturnType<typeof store.getState> => store.getState()
    expect(ui()).toMatchObject({
      marquee: null,
      quickHidden: false,
      inspectorOpen: false,
      renaming: null,
      hintDismissed: false
    })

    ui().setMarquee({ x: 1, y: 2, width: 3, height: 4 })
    ui().toggleQuickHidden()
    ui().setInspectorOpen(true)
    ui().startRename({ kind: 'group', id: 'g' })
    ui().dismissHint()
    expect(ui()).toMatchObject({
      marquee: { x: 1, y: 2, width: 3, height: 4 },
      quickHidden: true,
      inspectorOpen: true,
      renaming: { kind: 'group', id: 'g' },
      hintDismissed: true
    })

    ui().stopRename()
    ui().setQuickHidden(false)
    expect(ui().renaming).toBeNull()
    expect(ui().quickHidden).toBe(false)
  })

  it('confirm() resolves with the user’s answer and closes the request', async () => {
    const store = createUiStore()

    const answer = store.getState().confirm({ title: 'Delete group?', description: '3 items' })
    expect(store.getState().confirmRequest).toMatchObject({
      title: 'Delete group?',
      description: '3 items',
      confirmLabel: 'OK',
      destructive: false
    })
    store.getState().resolveConfirm(true)

    await expect(answer).resolves.toBe(true)
    expect(store.getState().confirmRequest).toBeNull()
  })

  it('a second confirm() cancels the first one', async () => {
    const store = createUiStore()
    const first = store.getState().confirm({ title: 'one', description: '' })
    const second = store.getState().confirm({ title: 'two', description: '' })
    await expect(first).resolves.toBe(false)
    store.getState().resolveConfirm(false)
    await expect(second).resolves.toBe(false)
  })
})

describe('ui store — drag and drop (Phase 8)', () => {
  it('tracks the item drag and the drop hint, notifying only on a real change', () => {
    const store = createUiStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store
      .getState()
      .setDrag({ ids: ['1:1', '1:2'], activeId: '1:2', sourceGroups: ['a'], pointer: true })
    expect(store.getState().drag).toEqual({
      ids: ['1:1', '1:2'],
      activeId: '1:2',
      sourceGroups: ['a'],
      pointer: true
    })

    store.getState().setDropHint({ kind: 'group', groupId: 'a', index: 2 })
    store.getState().setDropHint({ kind: 'group', groupId: 'a', index: 2 })
    store.getState().setDropHint({ kind: 'canvas', point: { x: 96, y: 0 } })
    store.getState().setDropHint({ kind: 'canvas', point: { x: 96, y: 0 } })
    expect(store.getState().dropHint).toEqual({ kind: 'canvas', point: { x: 96, y: 0 } })
    expect(listener).toHaveBeenCalledTimes(3)

    store.getState().endDrag()
    expect(store.getState().drag).toBeNull()
    expect(store.getState().dropHint).toBeNull()
  })
})

describe('ui store — snap guides (round 2)', () => {
  it('holds the guide lines of the move or resize in progress, notifying only on a change', () => {
    const store = createUiStore()
    const listener = vi.fn()
    store.subscribe(listener)
    expect(store.getState().snapGuides).toEqual([])

    const guide = { axis: 'x' as const, at: 680, from: 100, to: 300 }
    store.getState().setSnapGuides([guide])
    store.getState().setSnapGuides([{ ...guide }])
    expect(store.getState().snapGuides).toEqual([guide])
    store.getState().setSnapGuides([])
    store.getState().setSnapGuides([])
    expect(store.getState().snapGuides).toEqual([])
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
