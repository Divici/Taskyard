import { describe, expect, it, vi } from 'vitest'
import { parseUrlFile, readShortcut, type ShortcutDeps } from './shortcuts'
import { driveItem, networkItem, rootItem, writeLnk } from './test/lnk-writer'

const MY_COMPUTER = '{20D04FE0-3AEA-1069-A2D8-08002B30309D}'
const LNK = 'C:\\Users\\me\\Desktop\\Tool.lnk'

function deps(bytes: Buffer, overrides: Partial<ShortcutDeps> = {}): ShortcutDeps {
  return {
    readFile: vi.fn(async () => bytes),
    readShortcutLink: vi.fn(() => ({ target: 'C:\\From\\Shell.exe', icon: '', iconIndex: 0 })),
    env: { SystemRoot: 'C:\\Windows' },
    log: { warn: vi.fn() },
    ...overrides
  }
}

describe('parseUrlFile (.url INI)', () => {
  it('reads URL, IconFile and IconIndex from [InternetShortcut]', () => {
    const text =
      '[{000214A0-0000-0000-C000-000000000046}]\r\nProp3=19,11\r\n' +
      '[InternetShortcut]\r\nIDList=\r\nURL=https://github.com/\r\n' +
      'IconFile=C:\\Icons\\gh.ico\r\nIconIndex=3\r\nHotKey=0\r\n'

    expect(parseUrlFile(Buffer.from(text))).toEqual({
      url: 'https://github.com/',
      iconFile: 'C:\\Icons\\gh.ico',
      iconIndex: 3
    })
  })

  it('ignores keys in other sections, key case and blank lines; LF endings work', () => {
    const text =
      '[DEFAULT]\nBASEURL=https://wrong.example/\n\n[internetshortcut]\nurl = https://right.example/a?b=c\n'

    expect(parseUrlFile(Buffer.from(text))).toEqual({ url: 'https://right.example/a?b=c' })
  })

  it('decodes a UTF-8 or UTF-16LE byte-order mark', () => {
    const body = '[InternetShortcut]\r\nURL=https://example.com/ü\r\n'
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')])
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')])

    expect(parseUrlFile(utf8).url).toBe('https://example.com/ü')
    expect(parseUrlFile(utf16).url).toBe('https://example.com/ü')
  })

  it('leaves out a missing URL and a non-numeric IconIndex', () => {
    expect(parseUrlFile(Buffer.from('[InternetShortcut]\r\nIconIndex=abc\r\n'))).toEqual({})
    expect(parseUrlFile(Buffer.from('not an ini file at all'))).toEqual({})
  })
})

describe('readShortcut', () => {
  it('.url → url, and IconFile with environment variables expanded', async () => {
    const bytes = Buffer.from(
      '[InternetShortcut]\r\nURL=https://x.example/\r\nIconFile=%SystemRoot%\\a.ico\r\nIconIndex=1\r\n'
    )

    expect(await readShortcut('C:\\D\\x.url', 'url', deps(bytes))).toEqual({
      url: 'https://x.example/',
      iconPath: 'C:\\Windows\\a.ico',
      iconIndex: 1
    })
  })

  it('.lnk parsed locally never calls shell.readShortcutLink', async () => {
    const d = deps(writeLnk({ localBasePath: 'C:\\Tools\\tool.exe', iconIndex: 2 }))

    expect(await readShortcut(LNK, 'link', d)).toEqual({
      targetPath: 'C:\\Tools\\tool.exe',
      targetRemote: false,
      iconIndex: 2
    })
    expect(d.readShortcutLink).not.toHaveBeenCalled()
  })

  it('a UNC .lnk resolves from the file alone: no fallback, nothing touches the target', async () => {
    const d = deps(
      writeLnk({ network: { netName: '\\\\dead-server\\gone' }, commonPathSuffix: 'x.exe' })
    )

    expect(await readShortcut(LNK, 'link', d)).toEqual({
      targetPath: '\\\\dead-server\\gone\\x.exe',
      targetRemote: true,
      iconIndex: 0
    })
    expect(d.readShortcutLink).not.toHaveBeenCalled()
    expect(d.readFile).toHaveBeenCalledExactlyOnceWith(LNK)
  })

  it('falls back to shell.readShortcutLink for a local link without a path (IDList only)', async () => {
    const d = deps(writeLnk({ idList: [rootItem(MY_COMPUTER), driveItem('C:\\')] }))

    expect(await readShortcut(LNK, 'link', d)).toEqual({
      targetPath: 'C:\\From\\Shell.exe',
      targetRemote: false,
      iconIndex: 0
    })
    expect(d.readShortcutLink).toHaveBeenCalledExactlyOnceWith(LNK)
  })

  it('never falls back for a network link without a path', async () => {
    const d = deps(writeLnk({ idList: [networkItem(0xc3, '\\\\nas\\share')] }))

    expect(await readShortcut(LNK, 'link', d)).toEqual({ targetRemote: true, iconIndex: 0 })
    expect(d.readShortcutLink).not.toHaveBeenCalled()
  })

  it('on a parser failure falls back only when the part it read proved the link local', async () => {
    const local = writeLnk({
      localBasePath: 'C:\\Tools\\tool.exe',
      name: 'A rather long description that gets cut'
    })
    const localCut = local.subarray(0, local.indexOf(Buffer.from('rather', 'utf16le')))
    const d = deps(localCut)
    expect(await readShortcut(LNK, 'link', d)).toMatchObject({ targetPath: 'C:\\From\\Shell.exe' })
    expect(d.readShortcutLink).toHaveBeenCalledOnce()

    const remote = writeLnk({
      network: { netName: '\\\\nas\\share' },
      name: 'A rather long description that gets cut'
    })
    const remoteCut = remote.subarray(0, remote.indexOf(Buffer.from('rather', 'utf16le')))
    const r = deps(remoteCut)
    expect(await readShortcut(LNK, 'link', r)).toEqual({ targetRemote: true })
    expect(r.readShortcutLink).not.toHaveBeenCalled()

    // Cut inside the header: nothing is known about the target, so no fallback either.
    const unknown = deps(local.subarray(0, 40))
    expect(await readShortcut(LNK, 'link', unknown)).toEqual({})
    expect(unknown.readShortcutLink).not.toHaveBeenCalled()
    expect(unknown.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('shortcuts: could not parse'),
      expect.anything()
    )
  })

  it('marks a UNC answer from the fallback remote', async () => {
    const d = deps(writeLnk({ idList: [rootItem(MY_COMPUTER), driveItem('C:\\')] }), {
      readShortcutLink: vi.fn(() => ({
        target: '\\\\nas\\s\\a.exe',
        icon: 'C:\\i.ico',
        iconIndex: 4
      }))
    })

    expect(await readShortcut(LNK, 'link', d)).toEqual({
      targetPath: '\\\\nas\\s\\a.exe',
      targetRemote: true,
      iconPath: 'C:\\i.ico',
      iconIndex: 4
    })
  })

  it('keeps going (no target) when the fallback throws or is unavailable', async () => {
    const bytes = writeLnk({ idList: [rootItem(MY_COMPUTER), driveItem('C:\\')] })
    const throwing = deps(bytes, {
      readShortcutLink: vi.fn(() => {
        throw new Error('Failed to read shortcut link')
      })
    })
    expect(await readShortcut(LNK, 'link', throwing)).toEqual({ targetRemote: false, iconIndex: 0 })
    expect(throwing.log.warn).toHaveBeenCalledOnce()

    const none = deps(bytes, { readShortcutLink: undefined })
    expect(await readShortcut(LNK, 'link', none)).toEqual({ targetRemote: false, iconIndex: 0 })
  })

  it('returns nothing (and logs) when the file cannot be read', async () => {
    const d = deps(Buffer.alloc(0), {
      readFile: vi.fn(async () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      })
    })

    expect(await readShortcut(LNK, 'link', d)).toEqual({})
    expect(d.log.warn).toHaveBeenCalledOnce()
  })
})
