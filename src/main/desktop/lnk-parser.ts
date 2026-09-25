import { win32 } from 'node:path'
import { expandEnvVars, type Env } from './env-vars'

/**
 * A pure-TypeScript reader for Windows shell links (MS-SHLLINK,
 * https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/). It reads only the
 * `.lnk` bytes: nothing about the target is ever touched, so a shortcut to a dead UNC share
 * resolves instantly (Decision 12; `shell.readShortcutLink` is only a fallback, see
 * shortcuts.ts). Every read is bounds-checked; a short or malformed file throws `LnkParseError`
 * carrying whatever was read before the problem.
 */

const HEADER_SIZE = 0x4c
const LINK_CLSID = Buffer.from('0114020000000000c000000000000046', 'hex')

// LinkFlags.
const HAS_LINK_TARGET_ID_LIST = 0x1
const HAS_LINK_INFO = 0x2
const HAS_NAME = 0x4
const HAS_RELATIVE_PATH = 0x8
const HAS_WORKING_DIR = 0x10
const HAS_ARGUMENTS = 0x20
const HAS_ICON_LOCATION = 0x40
const IS_UNICODE = 0x80
const FORCE_NO_LINK_INFO = 0x100

// LinkInfoFlags.
const VOLUME_ID_AND_LOCAL_BASE_PATH = 0x1
const COMMON_NETWORK_RELATIVE_LINK_AND_PATH_SUFFIX = 0x2

/** VolumeID DriveType of a mapped network drive. */
const DRIVE_REMOTE = 4

// ExtraData block signatures read here (others are skipped by size).
const ENVIRONMENT_VARIABLE_DATA_BLOCK = 0xa0000001
const ICON_ENVIRONMENT_DATA_BLOCK = 0xa0000007
const ENV_BLOCK_MIN_SIZE = 0x314

/** Shell-item root CLSIDs that mean "the network". */
const NETWORK_ROOTS = new Set([
  '{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}', // Network
  '{208D2C60-3AEA-1069-A2D7-08002B30309D}' // My Network Places
])

export interface LnkLinkInfo {
  localBasePath?: string
  commonPathSuffix?: string
  /** `\\server\share` of a CommonNetworkRelativeLink. */
  netName?: string
  /** Mapped drive (`Z:`) of a CommonNetworkRelativeLink. */
  deviceName?: string
  /** VolumeID DriveType (3 fixed, 4 remote, 2 removable, …). */
  driveType?: number
}

/** What the LinkTargetIDList says about locality (its items are not turned into a path). */
export interface LnkIdListSummary {
  /** A drive item (`C:\`) is present. */
  hasDrive: boolean
  /** A network item or the Network root is present. */
  network: boolean
}

export interface LnkInfo {
  flags: number
  idList?: LnkIdListSummary
  linkInfo?: LnkLinkInfo
  name?: string
  relativePath?: string
  workingDir?: string
  arguments?: string
  iconLocation?: string
  /** Header IconIndex (signed; negative = resource id). */
  iconIndex: number
  /** EnvironmentVariableDataBlock target, unexpanded. */
  envTarget?: string
  /** IconEnvironmentDataBlock location, unexpanded. */
  envIcon?: string
}

export class LnkParseError extends Error {
  override name = 'LnkParseError'
  constructor(
    message: string,
    /** Everything read before the problem (used to decide whether a fallback is safe). */
    readonly partial: Partial<LnkInfo>
  ) {
    super(message)
  }
}

class Malformed extends Error {}

let ansiDecoder: TextDecoder | null | undefined
/** ANSI strings use the system code page; windows-1252 is right for ASCII and Western names. */
function decodeAnsi(bytes: Buffer): string {
  if (ansiDecoder === undefined) {
    try {
      ansiDecoder = new TextDecoder('windows-1252')
    } catch {
      ansiDecoder = null
    }
  }
  return ansiDecoder ? ansiDecoder.decode(bytes) : bytes.toString('latin1')
}

/** Bounds-checked little-endian reads over [start, end) of a buffer. */
class Reader {
  constructor(
    readonly buffer: Buffer,
    public pos = 0,
    readonly end = buffer.length
  ) {}

  need(bytes: number, what: string): void {
    if (bytes < 0 || this.pos + bytes > this.end) {
      throw new Malformed(`truncated ${what} at byte ${this.pos}`)
    }
  }
  u16(what: string): number {
    this.need(2, what)
    const value = this.buffer.readUInt16LE(this.pos)
    this.pos += 2
    return value
  }
  u32(what: string): number {
    this.need(4, what)
    const value = this.buffer.readUInt32LE(this.pos)
    this.pos += 4
    return value
  }
  bytes(length: number, what: string): Buffer {
    this.need(length, what)
    const value = this.buffer.subarray(this.pos, this.pos + length)
    this.pos += length
    return value
  }
}

/** A NUL-terminated string at `offset` within [start, end). */
function stringAt(
  buffer: Buffer,
  start: number,
  end: number,
  offset: number,
  wide: boolean,
  what: string
): string {
  const from = start + offset
  if (offset <= 0 || from >= end)
    throw new Malformed(`${what} offset ${offset} is outside LinkInfo`)
  if (wide) {
    for (let i = from; i + 1 < end; i += 2) {
      if (buffer[i] === 0 && buffer[i + 1] === 0) return buffer.toString('utf16le', from, i)
    }
  } else {
    const nul = buffer.indexOf(0, from)
    if (nul !== -1 && nul < end) return decodeAnsi(buffer.subarray(from, nul))
  }
  throw new Malformed(`${what} is not terminated inside LinkInfo`)
}

function guidAt(buffer: Buffer, offset: number): string {
  const hex = (value: number, width: number): string => value.toString(16).padStart(width, '0')
  const tail = buffer.subarray(offset + 8, offset + 16).toString('hex')
  return `{${hex(buffer.readUInt32LE(offset), 8)}-${hex(buffer.readUInt16LE(offset + 4), 4)}-${hex(
    buffer.readUInt16LE(offset + 6),
    4
  )}-${tail.slice(0, 4)}-${tail.slice(4)}}`.toUpperCase()
}

function readIdList(reader: Reader): LnkIdListSummary {
  const size = reader.u16('LinkTargetIDList size')
  const list = new Reader(reader.buffer, reader.pos, reader.pos + size)
  reader.need(size, 'LinkTargetIDList')
  reader.pos += size
  const summary: LnkIdListSummary = { hasDrive: false, network: false }
  for (;;) {
    const itemSize = list.u16('shell item size')
    if (itemSize === 0) return summary
    const item = list.bytes(itemSize - 2, 'shell item')
    if (item.length === 0) continue
    const type = item[0]
    if (type === 0x1f && item.length >= 18 && NETWORK_ROOTS.has(guidAt(item, 2)))
      summary.network = true
    if ((type & 0x70) === 0x40) summary.network = true
    if ((type & 0x70) === 0x20) summary.hasDrive = true
  }
}

function readLinkInfo(reader: Reader): LnkLinkInfo {
  const start = reader.pos
  const size = reader.u32('LinkInfo size')
  if (size < 0x1c) throw new Malformed(`LinkInfo size ${size} is too small`)
  reader.need(size - 4, 'LinkInfo')
  const end = start + size
  const header = new Reader(reader.buffer, reader.pos, end)
  reader.pos = end
  const buffer = reader.buffer

  const headerSize = header.u32('LinkInfoHeaderSize')
  const flags = header.u32('LinkInfoFlags')
  const volumeIdOffset = header.u32('VolumeIDOffset')
  const localBasePathOffset = header.u32('LocalBasePathOffset')
  const networkOffset = header.u32('CommonNetworkRelativeLinkOffset')
  const suffixOffset = header.u32('CommonPathSuffixOffset')
  const unicode = headerSize >= 0x24
  const localBasePathOffsetUnicode = unicode ? header.u32('LocalBasePathOffsetUnicode') : 0
  const suffixOffsetUnicode = unicode ? header.u32('CommonPathSuffixOffsetUnicode') : 0

  const info: LnkLinkInfo = {}
  if (flags & VOLUME_ID_AND_LOCAL_BASE_PATH) {
    if (volumeIdOffset + 8 > size) throw new Malformed('VolumeID is outside LinkInfo')
    info.driveType = buffer.readUInt32LE(start + volumeIdOffset + 4)
    info.localBasePath =
      localBasePathOffsetUnicode > 0
        ? stringAt(buffer, start, end, localBasePathOffsetUnicode, true, 'LocalBasePathUnicode')
        : stringAt(buffer, start, end, localBasePathOffset, false, 'LocalBasePath')
  }
  if (flags & COMMON_NETWORK_RELATIVE_LINK_AND_PATH_SUFFIX) {
    Object.assign(info, readNetworkLink(buffer, start + networkOffset, end))
  }
  if (suffixOffsetUnicode > 0) {
    info.commonPathSuffix = stringAt(
      buffer,
      start,
      end,
      suffixOffsetUnicode,
      true,
      'CommonPathSuffixUnicode'
    )
  } else if (suffixOffset > 0) {
    info.commonPathSuffix = stringAt(buffer, start, end, suffixOffset, false, 'CommonPathSuffix')
  }
  return info
}

function readNetworkLink(
  buffer: Buffer,
  start: number,
  linkInfoEnd: number
): Pick<LnkLinkInfo, 'netName' | 'deviceName'> {
  const reader = new Reader(buffer, start, linkInfoEnd)
  const size = reader.u32('CommonNetworkRelativeLink size')
  const end = start + size
  if (size < 0x14 || end > linkInfoEnd)
    throw new Malformed('CommonNetworkRelativeLink is outside LinkInfo')
  const flags = reader.u32('CommonNetworkRelativeLinkFlags')
  const netNameOffset = reader.u32('NetNameOffset')
  const deviceNameOffset = reader.u32('DeviceNameOffset')
  reader.u32('NetworkProviderType')
  const unicode = netNameOffset > 0x14
  const netNameOffsetUnicode = unicode ? reader.u32('NetNameOffsetUnicode') : 0
  const deviceNameOffsetUnicode = unicode ? reader.u32('DeviceNameOffsetUnicode') : 0

  const result: Pick<LnkLinkInfo, 'netName' | 'deviceName'> = {
    netName:
      netNameOffsetUnicode > 0
        ? stringAt(buffer, start, end, netNameOffsetUnicode, true, 'NetNameUnicode')
        : stringAt(buffer, start, end, netNameOffset, false, 'NetName')
  }
  if (flags & 0x1) {
    result.deviceName =
      deviceNameOffsetUnicode > 0
        ? stringAt(buffer, start, end, deviceNameOffsetUnicode, true, 'DeviceNameUnicode')
        : stringAt(buffer, start, end, deviceNameOffset, false, 'DeviceName')
  }
  return result
}

function readStringData(reader: Reader, unicode: boolean, what: string): string {
  const count = reader.u16(`${what} length`)
  const bytes = reader.bytes(unicode ? count * 2 : count, what)
  return unicode ? bytes.toString('utf16le') : decodeAnsi(bytes)
}

function readEnvBlock(block: Buffer): string | undefined {
  if (block.length < ENV_BLOCK_MIN_SIZE) throw new Malformed('environment data block is too small')
  const wide = block.subarray(268, 268 + 520)
  let end = 0
  while (end + 1 < wide.length && !(wide[end] === 0 && wide[end + 1] === 0)) end += 2
  const unicode = wide.toString('utf16le', 0, end)
  if (unicode !== '') return unicode
  const ansi = block.subarray(8, 8 + 260)
  const nul = ansi.indexOf(0)
  const text = decodeAnsi(ansi.subarray(0, nul === -1 ? ansi.length : nul))
  return text === '' ? undefined : text
}

export function parseLnk(bytes: Buffer): LnkInfo {
  const partial: Partial<LnkInfo> = {}
  const fail = (message: string): never => {
    throw new LnkParseError(`not a shell link: ${message}`, partial)
  }
  const prefix = bytes.subarray(0, Math.min(bytes.length, 20))
  const expected = Buffer.concat([Buffer.from([HEADER_SIZE, 0, 0, 0]), LINK_CLSID]).subarray(
    0,
    prefix.length
  )
  if (!prefix.equals(expected)) fail('wrong header size or CLSID')

  try {
    const reader = new Reader(bytes)
    reader.need(HEADER_SIZE, 'ShellLinkHeader')
    const flags = bytes.readUInt32LE(20)
    const info: LnkInfo = { flags, iconIndex: bytes.readInt32LE(56) }
    Object.assign(partial, info)
    reader.pos = HEADER_SIZE

    if (flags & HAS_LINK_TARGET_ID_LIST) partial.idList = info.idList = readIdList(reader)
    if (flags & HAS_LINK_INFO && !(flags & FORCE_NO_LINK_INFO)) {
      partial.linkInfo = info.linkInfo = readLinkInfo(reader)
    } else if (flags & HAS_LINK_INFO) {
      reader.pos += reader.u32('LinkInfo size') - 4
    }

    const unicode = (flags & IS_UNICODE) !== 0
    const strings: Array<
      [number, 'name' | 'relativePath' | 'workingDir' | 'arguments' | 'iconLocation']
    > = [
      [HAS_NAME, 'name'],
      [HAS_RELATIVE_PATH, 'relativePath'],
      [HAS_WORKING_DIR, 'workingDir'],
      [HAS_ARGUMENTS, 'arguments'],
      [HAS_ICON_LOCATION, 'iconLocation']
    ]
    for (const [flag, key] of strings) {
      if (flags & flag) partial[key] = info[key] = readStringData(reader, unicode, key)
    }

    for (;;) {
      const blockSize = reader.u32('ExtraData block size')
      if (blockSize < 4) break // TerminalBlock
      reader.pos -= 4
      const block = reader.bytes(blockSize, 'ExtraData block')
      if (block.length < 8) throw new Malformed('ExtraData block is too small')
      const signature = block.readUInt32LE(4)
      if (signature === ENVIRONMENT_VARIABLE_DATA_BLOCK) {
        const target = readEnvBlock(block)
        if (target !== undefined) partial.envTarget = info.envTarget = target
      } else if (signature === ICON_ENVIRONMENT_DATA_BLOCK) {
        const icon = readEnvBlock(block)
        if (icon !== undefined) partial.envIcon = info.envIcon = icon
      }
    }
    return info
  } catch (error) {
    if (error instanceof Malformed) throw new LnkParseError(error.message, partial)
    throw error
  }
}

/** `\\server\share…` or `\\?\UNC\…`, but not `\\?\C:\…` or `\\.\C:\…`. */
function isNetworkPath(path: string | undefined): boolean {
  if (path === undefined || !path.startsWith('\\\\')) return false
  return !/^\\\\[?.]\\[a-z]:/i.test(path)
}

/** What the parsed parts say about where the target lives. */
export function lnkLocality(info: Partial<LnkInfo>): { remote: boolean; local: boolean } {
  const linkInfo = info.linkInfo
  const remote =
    linkInfo?.netName !== undefined ||
    linkInfo?.driveType === DRIVE_REMOTE ||
    info.idList?.network === true ||
    isNetworkPath(info.envTarget) ||
    isNetworkPath(info.relativePath) ||
    isNetworkPath(linkInfo?.localBasePath)
  const local = !remote && (linkInfo?.localBasePath !== undefined || info.idList?.hasDrive === true)
  return { remote, local }
}

function joinSuffix(base: string, suffix: string | undefined): string {
  if (!suffix) return base
  return base.endsWith('\\') ? `${base}${suffix}` : `${base}\\${suffix}`
}

export interface ResolvedLnk {
  targetPath?: string
  /** On the network (UNC, mapped drive, network shell items): never touched, never extracted. */
  targetRemote: boolean
  /** Positively known to be on a local drive. */
  local: boolean
  iconPath?: string
  iconIndex: number
}

/**
 * The target and icon of a parsed link. Target order: the environment-variable target (what
 * Windows uses when it is present, e.g. `%ProgramFiles%` on another machine), then LinkInfo
 * (local base path or network share, plus the common suffix), then RelativePath against the
 * shortcut's folder. IDList-only links have no path here (see shortcuts.ts for the fallback).
 */
export function resolveLnk(info: LnkInfo, context: { lnkDir: string; env: Env }): ResolvedLnk {
  let targetPath: string | undefined
  const linkInfo = info.linkInfo
  if (info.envTarget !== undefined) {
    targetPath = expandEnvVars(info.envTarget, context.env)
  } else if (linkInfo?.localBasePath !== undefined) {
    targetPath = joinSuffix(linkInfo.localBasePath, linkInfo.commonPathSuffix)
  } else if (linkInfo?.netName !== undefined) {
    targetPath = joinSuffix(linkInfo.netName, linkInfo.commonPathSuffix)
  } else if (info.relativePath !== undefined) {
    targetPath = win32.resolve(context.lnkDir, expandEnvVars(info.relativePath, context.env))
  }

  const { remote, local } = lnkLocality(info)
  const targetRemote = remote || isNetworkPath(targetPath)
  const icon = info.envIcon ?? info.iconLocation
  const resolved: ResolvedLnk = {
    targetRemote,
    local: local && !targetRemote,
    iconIndex: info.iconIndex
  }
  if (targetPath !== undefined) resolved.targetPath = targetPath
  if (icon) resolved.iconPath = expandEnvVars(icon, context.env)
  return resolved
}
