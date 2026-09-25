/**
 * Test support: writes MS-SHLLINK (`.lnk`) files from a small spec, so fixtures (unit tests,
 * the 200-item bench, e2e) never need 150 COM calls. Follows
 * https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/ — ShellLinkHeader,
 * LinkTargetIDList, LinkInfo (VolumeID + LocalBasePath, or CommonNetworkRelativeLink),
 * StringData and ExtraData (environment / icon-environment blocks). Dependency-free so the
 * Playwright specs can import it too.
 */

export interface LnkNetworkSpec {
  /** `\\server\share`. */
  netName: string
  /** A mapped drive such as `Z:` (sets ValidDevice). */
  deviceName?: string
}

export interface LnkSpec {
  /** LinkInfo with VolumeIDAndLocalBasePath. */
  localBasePath?: string
  /** VolumeID drive type: 3 = DRIVE_FIXED (default), 4 = DRIVE_REMOTE (mapped drive). */
  driveType?: number
  /** LinkInfo with CommonNetworkRelativeLinkAndPathSuffix. */
  network?: LnkNetworkSpec
  /** Appended to the base path / net name. */
  commonPathSuffix?: string
  /** Also write the Unicode LinkInfo strings (LinkInfoHeaderSize 0x24). Default true. */
  linkInfoUnicode?: boolean
  name?: string
  relativePath?: string
  workingDir?: string
  arguments?: string
  iconLocation?: string
  iconIndex?: number
  /** EnvironmentVariableDataBlock target, e.g. `%SystemRoot%\system32\notepad.exe`. */
  envTarget?: string
  /** IconEnvironmentDataBlock location. */
  envIcon?: string
  /** Raw shell item ids (each without its 2-byte size). */
  idList?: Buffer[]
  /** StringData encoding: UTF-16LE (IsUnicode, default) or ANSI. */
  unicode?: boolean
  /** An unrecognised ExtraData block of this many bytes (real links carry property stores). */
  paddingBytes?: number
}

export const LNK_CLSID = Buffer.from('0114020000000000c000000000000046', 'hex')

const HEADER_SIZE = 0x4c
const ENV_BLOCK_SIZE = 0x314
const ENV_BLOCK_SIGNATURE = 0xa0000001
const ICON_ENV_BLOCK_SIGNATURE = 0xa0000007
const PADDING_BLOCK_SIGNATURE = 0xa0000009 // PropertyStoreDataBlock (contents are not parsed)

const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value)
  return buffer
}
const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}
const ansiz = (text: string): Buffer =>
  Buffer.concat([Buffer.from(text, 'latin1'), Buffer.alloc(1)])
const utf16z = (text: string): Buffer =>
  Buffer.concat([Buffer.from(text, 'utf16le'), Buffer.alloc(2)])

/** A shell item: `[size][type][…]`; a root item with a CLSID or a typed item. */
export function rootItem(clsid: string): Buffer {
  return Buffer.concat([Buffer.from([0x1f, 0x50]), guidBytes(clsid)])
}
export function driveItem(drive: string): Buffer {
  const name = Buffer.alloc(20)
  name.write(drive, 'latin1')
  return Buffer.concat([Buffer.from([0x2f]), name])
}
export function networkItem(type: number, path: string): Buffer {
  return Buffer.concat([Buffer.from([type, 0x02]), ansiz(path)])
}
export function fileItem(name: string): Buffer {
  return Buffer.concat([Buffer.from([0x32, 0x00]), Buffer.alloc(12), ansiz(name)])
}

/** `{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}` → the mixed-endian GUID layout. */
export function guidBytes(guid: string): Buffer {
  const hex = guid.replace(/[{}-]/g, '')
  const bytes = Buffer.from(hex, 'hex')
  const out = Buffer.alloc(16)
  out.writeUInt32LE(bytes.readUInt32BE(0), 0)
  out.writeUInt16LE(bytes.readUInt16BE(4), 4)
  out.writeUInt16LE(bytes.readUInt16BE(6), 6)
  bytes.copy(out, 8, 8)
  return out
}

function idListBlock(items: Buffer[]): Buffer {
  const body = Buffer.concat([
    ...items.map((item) => Buffer.concat([u16(item.length + 2), item])),
    u16(0)
  ])
  return Buffer.concat([u16(body.length), body])
}

function volumeId(driveType: number): Buffer {
  // VolumeIDSize, DriveType, DriveSerialNumber, VolumeLabelOffset (0x10), label "".
  const body = Buffer.concat([u32(driveType), u32(0x1234abcd), u32(0x10), Buffer.alloc(1)])
  return Buffer.concat([u32(body.length + 4), body])
}

function networkLink(spec: LnkNetworkSpec, unicode: boolean): Buffer {
  const fixed = unicode ? 0x1c : 0x14
  const net = ansiz(spec.netName)
  const device = spec.deviceName !== undefined ? ansiz(spec.deviceName) : Buffer.alloc(0)
  const netOffset = fixed
  const deviceOffset = spec.deviceName !== undefined ? netOffset + net.length : 0
  let tail = Buffer.concat([net, device])
  const unicodeOffsets: Buffer[] = []
  if (unicode) {
    const netU = utf16z(spec.netName)
    const deviceU = spec.deviceName !== undefined ? utf16z(spec.deviceName) : Buffer.alloc(0)
    const netUOffset = fixed + tail.length
    const deviceUOffset = spec.deviceName !== undefined ? netUOffset + netU.length : 0
    unicodeOffsets.push(u32(netUOffset), u32(deviceUOffset))
    tail = Buffer.concat([tail, netU, deviceU])
  }
  const flags = (spec.deviceName !== undefined ? 0x1 : 0) | 0x2 // ValidDevice, ValidNetType
  const header = Buffer.concat([
    u32(flags),
    u32(netOffset),
    u32(deviceOffset),
    u32(0x00020000), // WNNC_NET_LANMAN
    ...unicodeOffsets
  ])
  return Buffer.concat([u32(fixed + tail.length), header, tail])
}

function linkInfo(spec: LnkSpec): Buffer {
  const unicode = spec.linkInfoUnicode ?? true
  const headerSize = unicode ? 0x24 : 0x1c
  const suffix = spec.commonPathSuffix ?? ''
  const parts: Buffer[] = []
  let cursor = headerSize
  const place = (buffer: Buffer): number => {
    const offset = cursor
    parts.push(buffer)
    cursor += buffer.length
    return offset
  }

  let flags = 0
  let volumeOffset = 0
  let baseOffset = 0
  let networkOffset = 0
  let baseUOffset = 0
  if (spec.localBasePath !== undefined) {
    flags |= 0x1
    volumeOffset = place(volumeId(spec.driveType ?? 3))
    baseOffset = place(ansiz(spec.localBasePath))
  }
  if (spec.network !== undefined) {
    flags |= 0x2
    networkOffset = place(networkLink(spec.network, unicode))
  }
  const suffixOffset = place(ansiz(suffix))
  let suffixUOffset = 0
  if (unicode) {
    if (spec.localBasePath !== undefined) baseUOffset = place(utf16z(spec.localBasePath))
    suffixUOffset = place(utf16z(suffix))
  }

  const header = [
    u32(headerSize),
    u32(flags),
    u32(volumeOffset),
    u32(baseOffset),
    u32(networkOffset),
    u32(suffixOffset)
  ]
  if (unicode) header.push(u32(baseUOffset), u32(suffixUOffset))
  const body = Buffer.concat([...header, ...parts])
  return Buffer.concat([u32(body.length + 4), body])
}

function stringData(text: string, unicode: boolean): Buffer {
  return Buffer.concat([u16(text.length), Buffer.from(text, unicode ? 'utf16le' : 'latin1')])
}

function envBlock(signature: number, target: string): Buffer {
  const ansi = Buffer.alloc(260)
  ansi.write(target.slice(0, 259), 'latin1')
  const wide = Buffer.alloc(520)
  wide.write(target.slice(0, 259), 'utf16le')
  return Buffer.concat([u32(ENV_BLOCK_SIZE), u32(signature), ansi, wide])
}

export function writeLnk(spec: LnkSpec): Buffer {
  const unicode = spec.unicode ?? true
  const hasLinkInfo = spec.localBasePath !== undefined || spec.network !== undefined
  let flags = 0
  if (spec.idList !== undefined) flags |= 0x1
  if (hasLinkInfo) flags |= 0x2
  if (spec.name !== undefined) flags |= 0x4
  if (spec.relativePath !== undefined) flags |= 0x8
  if (spec.workingDir !== undefined) flags |= 0x10
  if (spec.arguments !== undefined) flags |= 0x20
  if (spec.iconLocation !== undefined) flags |= 0x40
  if (unicode) flags |= 0x80
  if (spec.envTarget !== undefined) flags |= 0x200
  if (spec.envIcon !== undefined) flags |= 0x4000

  const header = Buffer.alloc(HEADER_SIZE)
  header.writeUInt32LE(HEADER_SIZE, 0)
  LNK_CLSID.copy(header, 4)
  header.writeUInt32LE(flags, 20)
  header.writeUInt32LE(0x20, 24) // FILE_ATTRIBUTE_ARCHIVE
  header.writeInt32LE(spec.iconIndex ?? 0, 56)
  header.writeUInt32LE(1, 60) // SW_SHOWNORMAL

  const sections: Buffer[] = [header]
  if (spec.idList !== undefined) sections.push(idListBlock(spec.idList))
  if (hasLinkInfo) sections.push(linkInfo(spec))
  for (const text of [
    spec.name,
    spec.relativePath,
    spec.workingDir,
    spec.arguments,
    spec.iconLocation
  ]) {
    if (text !== undefined) sections.push(stringData(text, unicode))
  }
  if (spec.envTarget !== undefined) sections.push(envBlock(ENV_BLOCK_SIGNATURE, spec.envTarget))
  if (spec.envIcon !== undefined) sections.push(envBlock(ICON_ENV_BLOCK_SIGNATURE, spec.envIcon))
  if (spec.paddingBytes !== undefined) {
    sections.push(u32(spec.paddingBytes + 8), u32(PADDING_BLOCK_SIGNATURE))
    sections.push(Buffer.alloc(spec.paddingBytes, 0x5a))
  }
  sections.push(u32(0)) // TerminalBlock
  return Buffer.concat(sections)
}
