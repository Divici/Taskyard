import { describe, expect, it } from 'vitest'
import type { DesktopChange } from '@shared/ipc'
import type { DesktopItem } from '@shared/schema'
import { createNewItemTracker, NEW_ITEM_WINDOW_MS } from './new-item-tracker'

const DESKTOP = 'C:\\Users\\me\\Desktop'
const PUBLIC = 'C:\\Users\\Public\\Desktop'

function item(id: string, path: string): DesktopItem {
  return {
    id,
    path,
    name: path.slice(path.lastIndexOf('\\') + 1),
    ext: '',
    kind: 'folder',
    mtimeMs: 0,
    sizeBytes: 0,
    readonly: false,
    placeholder: false
  }
}

const added = (...items: DesktopItem[]): DesktopChange => ({
  added: items,
  removed: [],
  changed: []
})

function setup(): { tracker: ReturnType<typeof createNewItemTracker>; clock: { now: number } } {
  const clock = { now: 1_000 }
  const tracker = createNewItemTracker({ userDesktop: DESKTOP, now: () => clock.now })
  // The boot scan: every item main knows arrives as added once.
  tracker.annotate(added(item('1:1', `${DESKTOP}\\old.txt`), item('1:2', `${PUBLIC}\\app.lnk`)))
  return { tracker, clock }
}

describe('createNewItemTracker (New ▸ / Paste items go to the right-click point)', () => {
  it('has a 3 s window', () => {
    expect(NEW_ITEM_WINDOW_MS).toBe(3_000)
  })

  it('leaves changes alone while nothing is expected', () => {
    const { tracker } = setup()
    const change = added(item('1:3', `${DESKTOP}\\New folder`))
    expect(tracker.annotate(change)).toBe(change)
  })

  it('places the next new item in the user Desktop at the point, with inline rename (New ▸)', () => {
    const { tracker, clock } = setup()
    tracker.expect({ displayId: 7, point: { x: 400, y: 300 }, rename: true })
    clock.now += 500
    const change = added(item('1:3', `${DESKTOP}\\New folder`))

    expect(tracker.annotate(change)).toEqual({
      ...change,
      placeAt: { displayId: 7, point: { x: 400, y: 300 }, ids: ['1:3'], renameId: '1:3' }
    })
    // One New ▸ command makes one item: the next one is placed as usual.
    const later = added(item('1:4', `${DESKTOP}\\other.txt`))
    expect(tracker.annotate(later)).toBe(later)
  })

  it('places pasted items without renaming, for every batch within the window', () => {
    const { tracker, clock } = setup()
    tracker.expect({ displayId: 1, point: { x: 10, y: 20 }, rename: false })
    const first = tracker.annotate(
      added(item('1:3', `${DESKTOP}\\a.txt`), item('1:4', `${DESKTOP}\\b.txt`))
    )
    expect(first.placeAt).toEqual({
      displayId: 1,
      point: { x: 10, y: 20 },
      ids: ['1:3', '1:4'],
      renameId: null
    })
    clock.now += 1_000
    expect(tracker.annotate(added(item('1:5', `${DESKTOP}\\c.txt`))).placeAt?.ids).toEqual(['1:5'])
  })

  it('expires after 3 s', () => {
    const { tracker, clock } = setup()
    tracker.expect({ displayId: 1, point: { x: 10, y: 20 }, rename: true })
    clock.now += NEW_ITEM_WINDOW_MS + 1
    const change = added(item('1:3', `${DESKTOP}\\New folder`))
    expect(tracker.annotate(change)).toBe(change)
  })

  it('ignores items it already knew (a rescan lists everything as added) and other folders', () => {
    const { tracker } = setup()
    tracker.expect({ displayId: 1, point: { x: 10, y: 20 }, rename: true })
    const rescan = added(item('1:1', `${DESKTOP}\\old.txt`), item('1:2', `${PUBLIC}\\app.lnk`))
    expect(tracker.annotate(rescan)).toBe(rescan)
    const elsewhere = added(item('1:9', `${PUBLIC}\\new.lnk`))
    expect(tracker.annotate(elsewhere)).toBe(elsewhere)
    // Still armed for the real one; the folder compares case- and slash-insensitively.
    expect(
      tracker.annotate(added(item('1:3', 'c:/users/ME/desktop/New folder'))).placeAt?.renameId
    ).toBe('1:3')
  })

  it('forgets removed ids, so an item that comes back counts as new', () => {
    const { tracker } = setup()
    tracker.annotate({ added: [], removed: ['1:1'], changed: [] })
    tracker.expect({ displayId: 1, point: { x: 0, y: 0 }, rename: false })
    expect(tracker.annotate(added(item('1:1', `${DESKTOP}\\old.txt`))).placeAt?.ids).toEqual([
      '1:1'
    ])
  })

  it('a newer expectation replaces the older one', () => {
    const { tracker } = setup()
    tracker.expect({ displayId: 1, point: { x: 0, y: 0 }, rename: false })
    tracker.expect({ displayId: 2, point: { x: 5, y: 5 }, rename: true })
    expect(tracker.annotate(added(item('1:3', `${DESKTOP}\\x`))).placeAt).toEqual({
      displayId: 2,
      point: { x: 5, y: 5 },
      ids: ['1:3'],
      renameId: '1:3'
    })
  })
})
