import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FILE_ID_PATTERN } from '@shared/schema'
import { fileIdOf, HASH_CONCURRENCY, hashPath } from './file-hash'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'taskyard-hash-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('hashPath', () => {
  it('is the SHA-256 of a file', async () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'hello')

    expect(await hashPath(file)).toBe(createHash('sha256').update('hello').digest('hex'))
  })

  it('gives equal folder trees equal hashes and differing trees different hashes', async () => {
    const make = (name: string, files: Record<string, string>): string => {
      const root = join(dir, name)
      for (const [relative, content] of Object.entries(files)) {
        const path = join(root, relative)
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, content)
      }
      return root
    }
    const a = make('a', { 'x.txt': '1', 'sub/y.txt': '2' })
    const b = make('b', { 'sub/y.txt': '2', 'x.txt': '1' })
    const renamed = make('c', { 'x.txt': '1', 'sub/z.txt': '2' })
    const changed = make('d', { 'x.txt': '1', 'sub/y.txt': '3' })

    expect(await hashPath(a)).toBe(await hashPath(b))
    expect(await hashPath(a)).not.toBe(await hashPath(renamed))
    expect(await hashPath(a)).not.toBe(await hashPath(changed))
  })
})

describe('hashPath on a large folder', () => {
  it('hashes at most 8 files at a time, so a huge folder cannot run out of file handles', async () => {
    const root = join(dir, 'big')
    mkdirSync(join(root, 'nested'), { recursive: true })
    for (let n = 0; n < 40; n++)
      writeFileSync(join(root, n % 2 ? 'nested' : '', `f${n}.txt`), `${n}`)
    let open = 0
    let peak = 0
    const hashFile = async (path: string): Promise<string> => {
      open += 1
      peak = Math.max(peak, open)
      await new Promise((resolve) => setTimeout(resolve, 2))
      open -= 1
      return path
    }

    await hashPath(root, { hashFile })

    expect(HASH_CONCURRENCY).toBe(8)
    expect(peak).toBe(HASH_CONCURRENCY)
  })

  it('still hashes every file of a folder with more files than the limit', async () => {
    const make = (name: string, extra: string): string => {
      const root = join(dir, name)
      mkdirSync(root)
      for (let n = 0; n < 30; n++) writeFileSync(join(root, `f${n}.txt`), `${n}`)
      writeFileSync(join(root, 'last.txt'), extra)
      return root
    }

    expect(await hashPath(make('a', 'same'))).toBe(await hashPath(make('b', 'same')))
    expect(await hashPath(make('c', 'same'))).not.toBe(await hashPath(make('d', 'diff')))
  })
})

describe('fileIdOf', () => {
  it('returns `${dev}:${ino}` from a bigint stat', async () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')

    expect(await fileIdOf(file)).toMatch(FILE_ID_PATTERN)
  })

  it('keeps the id across a rename on the same volume', async () => {
    const before = join(dir, 'before.txt')
    const after = join(dir, 'after.txt')
    writeFileSync(before, 'x')
    const id = await fileIdOf(before)

    renameSync(before, after)

    expect(await fileIdOf(after)).toBe(id)
  })
})
