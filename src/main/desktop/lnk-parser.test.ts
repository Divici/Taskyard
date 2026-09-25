import { describe, expect, it } from 'vitest'
import { LnkParseError, parseLnk, resolveLnk } from './lnk-parser'
import {
  driveItem,
  fileItem,
  networkItem,
  rootItem,
  writeLnk,
  type LnkSpec
} from './test/lnk-writer'

const MY_COMPUTER = '{20D04FE0-3AEA-1069-A2D8-08002B30309D}'
const NETWORK = '{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}'
const LNK_DIR = 'C:\\Users\\me\\Desktop'
const ENV = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }

function resolve(spec: LnkSpec): ReturnType<typeof resolveLnk> {
  return resolveLnk(parseLnk(writeLnk(spec)), { lnkDir: LNK_DIR, env: ENV })
}

describe('parseLnk (MS-SHLLINK)', () => {
  it('reads a local target from LinkInfo LocalBasePath (Unicode and ANSI-only headers)', () => {
    const target = 'C:\\Program Files\\Notepad++\\notepad++.exe'

    for (const linkInfoUnicode of [true, false]) {
      const info = parseLnk(writeLnk({ localBasePath: target, linkInfoUnicode }))
      expect(info.linkInfo).toMatchObject({ localBasePath: target, driveType: 3 })
      expect(resolveLnk(info, { lnkDir: LNK_DIR, env: ENV })).toMatchObject({
        targetPath: target,
        targetRemote: false
      })
    }
  })

  it('appends CommonPathSuffix to the base path', () => {
    expect(
      resolve({ localBasePath: 'D:\\Games\\', commonPathSuffix: 'Chess\\chess.exe' }).targetPath
    ).toBe('D:\\Games\\Chess\\chess.exe')
    expect(resolve({ localBasePath: 'D:\\Games', commonPathSuffix: 'chess.exe' }).targetPath).toBe(
      'D:\\Games\\chess.exe'
    )
  })

  it('reads a UNC target from CommonNetworkRelativeLink and marks it remote', () => {
    const spec: LnkSpec = {
      network: { netName: '\\\\fileserver\\team' },
      commonPathSuffix: 'Plans\\roadmap.docx'
    }

    const info = parseLnk(writeLnk(spec))
    expect(info.linkInfo?.netName).toBe('\\\\fileserver\\team')
    expect(resolve(spec)).toMatchObject({
      targetPath: '\\\\fileserver\\team\\Plans\\roadmap.docx',
      targetRemote: true
    })
    // ANSI-only CommonNetworkRelativeLink (NetNameOffset == 0x14) reads the same.
    expect(resolve({ ...spec, linkInfoUnicode: false }).targetPath).toBe(
      '\\\\fileserver\\team\\Plans\\roadmap.docx'
    )
  })

  it('treats a mapped network drive as remote even though its base path is a drive path', () => {
    const result = resolve({
      localBasePath: 'Z:\\Reports\\q3.xlsx',
      driveType: 4,
      network: { netName: '\\\\fileserver\\reports', deviceName: 'Z:' }
    })

    expect(result.targetPath).toBe('Z:\\Reports\\q3.xlsx')
    expect(result.targetRemote).toBe(true)
  })

  it('expands %SystemRoot% in an EnvironmentVariableDataBlock target (preferred over LinkInfo)', () => {
    const spec: LnkSpec = {
      localBasePath: 'C:\\OldMachine\\notepad.exe',
      envTarget: '%SystemRoot%\\system32\\notepad.exe'
    }

    expect(parseLnk(writeLnk(spec)).envTarget).toBe('%SystemRoot%\\system32\\notepad.exe')
    expect(resolve(spec)).toMatchObject({
      targetPath: 'C:\\Windows\\system32\\notepad.exe',
      targetRemote: false
    })
    // Environment names are case-insensitive on Windows; unknown ones stay as written.
    expect(resolve({ envTarget: '%systemroot%\\x.exe' }).targetPath).toBe('C:\\Windows\\x.exe')
    expect(resolve({ envTarget: '%NoSuchVar%\\x.exe' }).targetPath).toBe('%NoSuchVar%\\x.exe')
  })

  it('reads IconLocation and the header IconIndex (negative = resource id), expanding env vars', () => {
    const info = parseLnk(
      writeLnk({
        localBasePath: 'C:\\Tools\\tool.exe',
        iconLocation: '%SystemRoot%\\System32\\shell32.dll',
        iconIndex: -154
      })
    )

    expect(info.iconLocation).toBe('%SystemRoot%\\System32\\shell32.dll')
    expect(info.iconIndex).toBe(-154)
    expect(resolveLnk(info, { lnkDir: LNK_DIR, env: ENV })).toMatchObject({
      iconPath: 'C:\\Windows\\System32\\shell32.dll',
      iconIndex: -154
    })
  })

  it('prefers the IconEnvironmentDataBlock location over the IconLocation string', () => {
    const result = resolve({
      localBasePath: 'C:\\x.exe',
      iconLocation: 'C:\\stale.ico',
      envIcon: '%ProgramFiles%\\App\\app.ico',
      iconIndex: 2
    })

    expect(result).toMatchObject({ iconPath: 'C:\\Program Files\\App\\app.ico', iconIndex: 2 })
  })

  it('reads every StringData field, in Unicode and in ANSI', () => {
    for (const unicode of [true, false]) {
      const info = parseLnk(
        writeLnk({
          unicode,
          localBasePath: 'C:\\Tools\\tool.exe',
          name: 'My tool',
          relativePath: '..\\..\\..\\Tools\\tool.exe',
          workingDir: 'C:\\Tools',
          arguments: '--fast "a b"',
          iconLocation: 'C:\\Tools\\tool.ico'
        })
      )
      expect(info).toMatchObject({
        name: 'My tool',
        relativePath: '..\\..\\..\\Tools\\tool.exe',
        workingDir: 'C:\\Tools',
        arguments: '--fast "a b"',
        iconLocation: 'C:\\Tools\\tool.ico'
      })
    }
  })

  it('resolves RelativePath against the shortcut folder when there is no LinkInfo', () => {
    expect(resolve({ relativePath: '.\\Docs\\a.txt' }).targetPath).toBe(
      'C:\\Users\\me\\Desktop\\Docs\\a.txt'
    )
    expect(resolve({ relativePath: '\\\\nas\\share\\a.txt' })).toMatchObject({
      targetPath: '\\\\nas\\share\\a.txt',
      targetRemote: true
    })
  })

  it('summarises the IDList: a drive item is local, a network item or the Network root is remote', () => {
    const local = parseLnk(
      writeLnk({ idList: [rootItem(MY_COMPUTER), driveItem('C:\\'), fileItem('a.txt')] })
    )
    expect(local.idList).toEqual({ hasDrive: true, network: false })
    const resolvedLocal = resolveLnk(local, { lnkDir: LNK_DIR, env: ENV })
    expect(resolvedLocal).toMatchObject({ targetRemote: false, local: true })
    expect(resolvedLocal.targetPath).toBeUndefined()

    const share = parseLnk(writeLnk({ idList: [networkItem(0xc3, '\\\\nas\\share')] }))
    expect(share.idList?.network).toBe(true)
    const root = parseLnk(writeLnk({ idList: [rootItem(NETWORK), networkItem(0x42, '\\\\nas')] }))
    expect(resolveLnk(root, { lnkDir: LNK_DIR, env: ENV })).toMatchObject({
      targetRemote: true,
      local: false
    })
  })

  it('skips an ExtraData block it does not know', () => {
    expect(
      resolve({ localBasePath: 'C:\\a.exe', paddingBytes: 900, envIcon: 'C:\\b.ico' }).iconPath
    ).toBe('C:\\b.ico')
  })

  it('rejects a file that is not a shell link', () => {
    expect(() => parseLnk(Buffer.from('[InternetShortcut]\r\nURL=https://x/\r\n'))).toThrow(
      LnkParseError
    )
    const wrongClsid = writeLnk({ localBasePath: 'C:\\a.exe' })
    wrongClsid[4] ^= 0xff
    expect(() => parseLnk(wrongClsid)).toThrow(/not a shell link/)
  })

  it('throws LnkParseError on a truncated file at any cut, keeping what it could read', () => {
    const whole = writeLnk({
      idList: [rootItem(MY_COMPUTER), driveItem('C:\\'), fileItem('tool.exe')],
      localBasePath: 'C:\\Tools\\tool.exe',
      name: 'My shortcut name',
      iconLocation: 'C:\\Tools\\tool.ico',
      envTarget: '%SystemRoot%\\tool.exe'
    })
    expect(() => parseLnk(whole)).not.toThrow()

    // Every cut short of the terminal block fails loudly, never with a RangeError.
    for (let cut = 0; cut < whole.length - 4; cut += 7) {
      let caught: unknown
      try {
        parseLnk(whole.subarray(0, cut))
      } catch (error) {
        caught = error
      }
      expect(caught, `cut at ${cut}`).toBeInstanceOf(LnkParseError)
    }

    // Cut inside StringData: the IDList and LinkInfo were read, and both say "local".
    const cut = whole.indexOf(Buffer.from('shortcut name', 'utf16le')) + 2
    try {
      parseLnk(whole.subarray(0, cut))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(LnkParseError)
      expect((error as LnkParseError).partial).toMatchObject({
        idList: { hasDrive: true, network: false },
        linkInfo: { localBasePath: 'C:\\Tools\\tool.exe' }
      })
      expect((error as LnkParseError).message).toMatch(/truncated/)
    }
  })

  it('rejects offsets that point outside LinkInfo', () => {
    const bytes = writeLnk({ localBasePath: 'C:\\a.exe', linkInfoUnicode: false })
    // LinkInfo starts right after the 76-byte header; LocalBasePathOffset is at +16.
    bytes.writeUInt32LE(0xffff, 76 + 16)

    expect(() => parseLnk(bytes)).toThrow(LnkParseError)
  })
})
