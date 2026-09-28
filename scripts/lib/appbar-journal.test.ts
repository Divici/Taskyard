import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APPBAR_JOURNAL_FILE, appbarJournal, healInterruptedRun } from './appbar-journal'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'taskyard-appbar-journal-'))
  file = join(dir, 'appbar.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('APPBAR_JOURNAL_FILE', () => {
  it('lives in the temp directory, so every run finds the same file', () => {
    expect(APPBAR_JOURNAL_FILE).toBe(join(tmpdir(), 'taskyard-verify-zorder-appbar.json'))
  })
})

describe('appbarJournal', () => {
  it('has nothing pending until a state is saved', () => {
    expect(appbarJournal(file).pending()).toBeNull()
  })

  it('writes the original state to disk before the taskbar is touched', () => {
    const journal = appbarJournal(file)

    journal.save(2)

    expect(journal.pending()).toBe(2)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ originalAppbarState: 2 })
  })

  it('keeps the first original when saved twice (the second state is already modified)', () => {
    const journal = appbarJournal(file)

    journal.save(0)
    journal.save(1)

    expect(journal.pending()).toBe(0)
  })

  it('forgets the state once cleared', () => {
    const journal = appbarJournal(file)
    journal.save(0)

    journal.clear()
    journal.clear()

    expect(existsSync(file)).toBe(false)
    expect(journal.pending()).toBeNull()
  })

  it('treats an unreadable journal as nothing pending and removes it', () => {
    writeFileSync(file, '{not json')

    expect(appbarJournal(file).pending()).toBeNull()
    expect(existsSync(file)).toBe(false)
  })
})

describe('healInterruptedRun', () => {
  it('restores the state an interrupted run left behind, then clears the journal', () => {
    appbarJournal(file).save(0)
    const restore = vi.fn(() => true)

    expect(healInterruptedRun(appbarJournal(file), restore)).toBe(0)
    expect(restore).toHaveBeenCalledExactlyOnceWith(0)
    expect(existsSync(file)).toBe(false)
  })

  it('keeps the journal when the restore does not take, so the next run tries again', () => {
    appbarJournal(file).save(0)

    expect(healInterruptedRun(appbarJournal(file), () => false)).toBe(0)
    expect(appbarJournal(file).pending()).toBe(0)
  })

  it('does nothing after a clean run', () => {
    const restore = vi.fn(() => true)

    expect(healInterruptedRun(appbarJournal(file), restore)).toBeNull()
    expect(restore).not.toHaveBeenCalled()
  })

  it('keeps the journal when restoring fails, so the next run tries again', () => {
    appbarJournal(file).save(0)

    expect(() =>
      healInterruptedRun(appbarJournal(file), () => {
        throw new Error('no taskbar')
      })
    ).toThrow('no taskbar')
    expect(appbarJournal(file).pending()).toBe(0)
  })
})
