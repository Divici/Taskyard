import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { splitItemName } from '@shared/item-name'
import type { DesktopItem } from '@shared/schema'
import { DesktopModel } from './model'
import {
  CHANGE_DEBOUNCE_MS,
  CHANGE_MAX_WAIT_MS,
  DesktopTracker,
  RENAME_WINDOW_MS,
  type TrackerSink
} from './watcher'

const DIR = 'C:\\Users\\me\\Desktop'
const PUB = 'C:\\Users\\Public\\Desktop'
const at = (name: string, dir = DIR): string => `${dir}\\${name}`

function item(id: string, path: string, patch: Partial<DesktopItem> = {}): DesktopItem {
  return {
    id,
    path,
    ...splitItemName(path, 'file'),
    kind: 'file',
    mtimeMs: 1,
    sizeBytes: 1,
    readonly: false,
    placeholder: false,
    ...patch
  }
}

/** The file system as the tracker sees it: path → item (what readItem would build). */
class FakeDisk {
  readonly files = new Map<string, DesktopItem>()
  hidden = new Set<string>()
  put(entry: DesktopItem): void {
    this.files.set(entry.path.toUpperCase(), entry)
  }
  remove(path: string): void {
    this.files.delete(path.toUpperCase())
  }
  rename(from: string, to: string): DesktopItem {
    const entry = this.files.get(from.toUpperCase())!
    this.remove(from)
    const moved = { ...entry, path: to, ...splitItemName(to, entry.kind) }
    this.put(moved)
    return moved
  }
  readItem = vi.fn(async (path: string): Promise<DesktopItem | null> => {
    if (this.hidden.has(path.toUpperCase())) return null
    const entry = this.files.get(path.toUpperCase())
    return entry ? { ...entry } : null
  })
  idAt = vi.fn(async (path: string) => this.files.get(path.toUpperCase())?.id ?? null)
  scan = vi.fn(async () => [...this.files.values()].map((entry) => ({ ...entry })))
}

let disk: FakeDisk
let model: DesktopModel
let sink: { [K in keyof TrackerSink]: ReturnType<typeof vi.fn> }
let log: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
let tracker: DesktopTracker

function seed(...entries: DesktopItem[]): void {
  for (const entry of entries) {
    disk.put(entry)
    model.put(entry)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  disk = new FakeDisk()
  model = new DesktopModel()
  sink = { changed: vi.fn(), renamed: vi.fn(), pathsMoved: vi.fn(), replaced: vi.fn() }
  log = { warn: vi.fn(), error: vi.fn() }
  tracker = new DesktopTracker({
    model,
    dirs: [DIR, PUB],
    readItem: disk.readItem,
    idAt: disk.idAt,
    scan: disk.scan,
    sink: sink as unknown as TrackerSink,
    log
  })
})

afterEach(() => {
  tracker.dispose()
  vi.useRealTimers()
})

describe("renames (Explorer's): the path → id map pairs an unlink with an add of the same id", () => {
  it('unlink then add within 500 ms is one desktop:renamed, never removed + added', async () => {
    seed(item('1:1', at('a.txt')))
    disk.rename(at('a.txt'), at('b.md'))

    tracker.handle('unlink', at('a.txt'))
    await vi.advanceTimersByTimeAsync(RENAME_WINDOW_MS - 100)
    tracker.handle('add', at('b.md'))
    await tracker.idle()

    expect(sink.renamed).toHaveBeenCalledExactlyOnceWith('1:1', at('b.md'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sink.changed).not.toHaveBeenCalled()
    expect(model.get('1:1')).toMatchObject({ path: at('b.md'), name: 'b', ext: '.md' })
    expect(model.idAt(at('a.txt'))).toBeUndefined()
  })

  it('the add may come first: still one rename, and the late unlink is ignored', async () => {
    seed(item('1:1', at('a.txt')))
    disk.rename(at('a.txt'), at('b.txt'))

    tracker.handle('add', at('b.txt'))
    tracker.handle('unlink', at('a.txt'))
    await tracker.idle()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(sink.renamed).toHaveBeenCalledExactlyOnceWith('1:1', at('b.txt'))
    expect(sink.changed).not.toHaveBeenCalled()
  })

  it('a case-only rename is a rename too', async () => {
    seed(item('1:1', at('notes.txt')))
    disk.rename(at('notes.txt'), at('Notes.TXT'))

    tracker.handle('unlink', at('notes.txt'))
    tracker.handle('add', at('Notes.TXT'))
    await tracker.idle()

    expect(sink.renamed).toHaveBeenCalledExactlyOnceWith('1:1', at('Notes.TXT'))
  })

  it('reports other changes that came with the rename (a new extension) as changed', async () => {
    seed(item('1:1', at('a.txt')))
    disk.rename(at('a.txt'), at('a.url'))
    disk.put({ ...disk.files.get(at('a.url').toUpperCase())!, kind: 'url', url: 'https://x/' })

    tracker.handle('unlink', at('a.txt'))
    tracker.handle('add', at('a.url'))
    await tracker.idle()
    await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS)

    expect(sink.renamed).toHaveBeenCalledExactlyOnceWith('1:1', at('a.url'))
    expect(sink.changed).toHaveBeenCalledExactlyOnceWith({
      added: [],
      removed: [],
      changed: [expect.objectContaining({ id: '1:1', kind: 'url', url: 'https://x/' })]
    })
  })
})

describe('adds, removals and changes', () => {
  it('an unlink with no matching add becomes removed once the 500 ms window has passed', async () => {
    seed(item('1:1', at('a.txt')))
    disk.remove(at('a.txt'))

    tracker.handle('unlink', at('a.txt'))
    await vi.advanceTimersByTimeAsync(RENAME_WINDOW_MS + CHANGE_DEBOUNCE_MS - 1)
    expect(sink.changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(sink.changed).toHaveBeenCalledExactlyOnceWith({
      added: [],
      removed: ['1:1'],
      changed: []
    })
    expect(model.get('1:1')).toBeUndefined()
  })

  it('debounces a storm into one desktop:changed, 150 ms after the last event', async () => {
    seed(item('1:1', at('a.txt')))
    disk.put(item('1:1', at('a.txt'), { sizeBytes: 99 }))
    disk.put(item('1:2', at('b.txt')))
    disk.put(item('1:3', at('c.txt')))
    disk.put(item('1:4', at('d.txt'), { sizeBytes: 5 }))

    tracker.handle('add', at('b.txt'))
    await vi.advanceTimersByTimeAsync(100)
    tracker.handle('add', at('c.txt'))
    tracker.handle('change', at('a.txt'))
    await vi.advanceTimersByTimeAsync(100)
    tracker.handle('add', at('d.txt'))
    tracker.handle('change', at('d.txt'))
    await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS - 1)
    expect(sink.changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(sink.changed).toHaveBeenCalledExactlyOnceWith({
      added: [
        expect.objectContaining({ id: '1:2' }),
        expect.objectContaining({ id: '1:3' }),
        expect.objectContaining({ id: '1:4', sizeBytes: 5 })
      ],
      removed: [],
      changed: [expect.objectContaining({ id: '1:1', sizeBytes: 99 })]
    })
  })

  it('a storm that never pauses is still flushed at least every second', async () => {
    for (let i = 0; i < 30; i++) {
      disk.put(item(`2:${i}`, at(`f${i}.txt`)))
      tracker.handle('add', at(`f${i}.txt`))
      await vi.advanceTimersByTimeAsync(100)
    }

    expect(sink.changed.mock.calls.length).toBeGreaterThanOrEqual(2)
    const firstBatch = sink.changed.mock.calls[0][0] as { added: DesktopItem[] }
    expect(firstBatch.added.length).toBeLessThanOrEqual(CHANGE_MAX_WAIT_MS / 100 + 1)
  })

  it('an item that goes and comes back within one batch is reported as changed', async () => {
    seed(item('1:1', at('a.txt')))
    disk.remove(at('a.txt'))
    tracker.handle('unlink', at('a.txt'))
    await vi.advanceTimersByTimeAsync(RENAME_WINDOW_MS + 10)

    disk.put(item('1:1', at('a.txt'), { sizeBytes: 7 }))
    tracker.handle('add', at('a.txt'))
    await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS)

    expect(sink.changed).toHaveBeenCalledExactlyOnceWith({
      added: [],
      removed: [],
      changed: [expect.objectContaining({ id: '1:1', sizeBytes: 7 })]
    })
  })

  it('a change that alters nothing is not reported', async () => {
    seed(item('1:1', at('a.txt')))

    tracker.handle('change', at('a.txt'))
    await tracker.idle()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(sink.changed).not.toHaveBeenCalled()
  })

  it('an item that became hidden is removed', async () => {
    seed(item('1:1', at('a.txt')))
    disk.hidden.add(at('a.txt').toUpperCase())

    tracker.handle('change', at('a.txt'))
    await tracker.idle()
    await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS)

    expect(sink.changed).toHaveBeenCalledExactlyOnceWith({
      added: [],
      removed: ['1:1'],
      changed: []
    })
  })

  it('a path that now holds a different file (an atomic save) is re-keyed, not lost', async () => {
    seed(item('1:1', at('Report.docx')))
    disk.put(item('1:9', at('Report.docx'), { sizeBytes: 4096 }))

    tracker.handle('change', at('Report.docx'))
    await tracker.idle()

    expect(sink.replaced).toHaveBeenCalledExactlyOnceWith('1:1', '1:9')
    await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS)
    expect(sink.changed).toHaveBeenCalledExactlyOnceWith({
      added: [expect.objectContaining({ id: '1:9', sizeBytes: 4096 })],
      removed: ['1:1'],
      changed: []
    })
    expect(model.idAt(at('Report.docx'))).toBe('1:9')
  })

  it('unlink + add of the same path with a new id within the window is the same re-key', async () => {
    seed(item('1:1', at('Report.docx')))
    disk.put(item('1:9', at('Report.docx')))

    tracker.handle('unlink', at('Report.docx'))
    tracker.handle('add', at('Report.docx'))
    await tracker.idle()
    await vi.advanceTimersByTimeAsync(RENAME_WINDOW_MS + CHANGE_DEBOUNCE_MS)

    expect(sink.replaced).toHaveBeenCalledExactlyOnceWith('1:1', '1:9')
    expect(sink.changed).toHaveBeenCalledOnce()
    expect(sink.renamed).not.toHaveBeenCalled()
  })

  it('ignores events outside the direct children of the desktop folders', async () => {
    disk.put(item('1:5', `${DIR}\\Projects\\inner.txt`))
    disk.put(item('1:6', DIR))

    tracker.handle('add', `${DIR}\\Projects\\inner.txt`)
    tracker.handle('addDir', DIR)
    tracker.handle('add', 'C:\\Elsewhere\\x.txt')
    await tracker.idle()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(disk.readItem).not.toHaveBeenCalled()
    expect(sink.changed).not.toHaveBeenCalled()
  })

  it('matches desktop folders case-insensitively and serves both of them', async () => {
    disk.put(item('3:1', at('Shared.lnk', PUB)))

    tracker.handle('add', at('Shared.lnk', PUB.toLowerCase()))
    await tracker.idle()
    await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS)

    expect(sink.changed).toHaveBeenCalledOnce()
  })

  it('logs a failing read and keeps processing later events', async () => {
    disk.readItem.mockRejectedValueOnce(new Error('EBUSY'))
    disk.put(item('1:2', at('b.txt')))

    tracker.handle('add', at('a.txt'))
    tracker.handle('add', at('b.txt'))
    await tracker.idle()
    await vi.advanceTimersByTimeAsync(CHANGE_DEBOUNCE_MS)

    expect(log.error).toHaveBeenCalledOnce()
    expect(sink.changed).toHaveBeenCalledExactlyOnceWith({
      added: [expect.objectContaining({ id: '1:2' })],
      removed: [],
      changed: []
    })
  })
})

describe('desktop:rescan', () => {
  it('re-emits a full list at once: every item added, vanished ids removed, moved paths reported', async () => {
    seed(item('1:1', at('a.txt')), item('1:2', at('b.txt')))
    disk.remove(at('a.txt'))
    disk.rename(at('b.txt'), at('b2.txt'))
    disk.put(item('1:3', at('c.txt')))
    tracker.handle('unlink', at('a.txt'))
    await tracker.idle()

    await tracker.rescan()

    expect(sink.changed).toHaveBeenCalledExactlyOnceWith({
      added: [
        expect.objectContaining({ id: '1:2', path: at('b2.txt') }),
        expect.objectContaining({ id: '1:3' })
      ],
      removed: ['1:1'],
      changed: []
    })
    expect(sink.pathsMoved).toHaveBeenCalledExactlyOnceWith(new Map([['1:2', at('b2.txt')]]))
    // The pending unlink was superseded by the full list.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sink.changed).toHaveBeenCalledOnce()
    expect(
      model
        .list()
        .map((entry) => entry.id)
        .sort()
    ).toEqual(['1:2', '1:3'])
  })

  it('sends a batch still waiting out its debounce before the full list', async () => {
    disk.put(item('1:4', at('d.txt')))
    tracker.handle('add', at('d.txt'))
    await tracker.idle()

    await tracker.rescan()

    expect(sink.changed).toHaveBeenCalledTimes(2)
    expect(sink.changed.mock.calls[1][0]).toEqual({
      added: [expect.objectContaining({ id: '1:4' })],
      removed: [],
      changed: []
    })
  })
})

describe('changes Taskyard makes itself (file-ops)', () => {
  it('applyRenamed reports the rename once; the watcher events that follow are no-ops', async () => {
    seed(item('1:1', at('a.txt')))
    disk.rename(at('a.txt'), at('b.txt'))

    await tracker.applyRenamed('1:1', at('b.txt'))
    expect(sink.renamed).toHaveBeenCalledExactlyOnceWith('1:1', at('b.txt'))

    tracker.handle('unlink', at('a.txt'))
    tracker.handle('add', at('b.txt'))
    await tracker.idle()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sink.renamed).toHaveBeenCalledOnce()
    expect(sink.changed).not.toHaveBeenCalled()
  })

  it('applyRemoved reports the removal right away; the later unlink is ignored', async () => {
    seed(item('1:1', at('a.txt')))
    disk.remove(at('a.txt'))

    await tracker.applyRemoved('1:1')
    expect(sink.changed).toHaveBeenCalledExactlyOnceWith({
      added: [],
      removed: ['1:1'],
      changed: []
    })

    tracker.handle('unlink', at('a.txt'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sink.changed).toHaveBeenCalledOnce()
  })

  it('applyPresent adds a moved-in item right away and returns it; the later add is a no-op', async () => {
    disk.put(item('1:7', at('moved.pdf')))

    const added = await tracker.applyPresent(at('moved.pdf'))

    expect(added).toMatchObject({ id: '1:7' })
    expect(sink.changed).toHaveBeenCalledExactlyOnceWith({
      added: [expect.objectContaining({ id: '1:7' })],
      removed: [],
      changed: []
    })
    tracker.handle('add', at('moved.pdf'))
    await tracker.idle()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sink.changed).toHaveBeenCalledOnce()
  })
})

describe('dispose', () => {
  it('cancels pending work and ignores later events', async () => {
    seed(item('1:1', at('a.txt')))
    disk.remove(at('a.txt'))
    tracker.handle('unlink', at('a.txt'))
    await tracker.idle()

    tracker.dispose()
    tracker.handle('add', at('x.txt'))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(sink.changed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
