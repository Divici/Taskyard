import type { Koffi } from './bindings'

// A minimal COM client over koffi: initialize the apartment, create an in-process object, call
// its methods through the vtable by index, release it. Enough for IDesktopWallpaper (wallpaper.ts)
// without a native addon. The parts that touch memory take a tiny koffi slice (`ComKoffi`) and
// an `Ole32` table, so they are tested headless against fakes (com.test.ts) and against the real
// DLLs in com.win32.test.ts.

/** Bytes per pointer (and per vtable slot) on 64-bit Windows, the only target. */
export const POINTER_SIZE = 8

export const S_OK = 0
export const S_FALSE = 1
/** CoInitializeEx: the thread is already in another apartment (Chromium's choice). Still usable. */
export const RPC_E_CHANGED_MODE = 0x80010106 | 0
export const COINIT_APARTMENTTHREADED = 0x2
export const CLSCTX_INPROC_SERVER = 0x1
export const CLSCTX_LOCAL_SERVER = 0x4
/** IUnknown's vtable: QueryInterface 0, AddRef 1, Release 2. */
export const IUNKNOWN_QUERY_INTERFACE = 0
export const IUNKNOWN_RELEASE = 2

/** The koffi functions a vtable call needs (`koffi.decode` with an offset, `koffi.call`). */
export interface ComKoffi {
  decode(pointer: bigint, offset: number, type: string): unknown
  call(fn: bigint, proto: unknown, ...args: unknown[]): unknown
}

/** A failed HRESULT (negative as a signed 32-bit integer). */
export class ComError extends Error {
  constructor(
    message: string,
    readonly hresult: number
  ) {
    super(message)
    this.name = 'ComError'
  }
}

/** `0x80070057` style, as Microsoft documents HRESULTs. */
export function hresultHex(hr: number): string {
  return `0x${(hr >>> 0).toString(16).padStart(8, '0')}`
}

/** Throws a `ComError` for a failed HRESULT; S_OK and S_FALSE (and any success code) pass. */
export function checkHr(hr: number, what: string): void {
  if ((hr | 0) < 0) throw new ComError(`${what} failed: HRESULT ${hresultHex(hr)}`, hr | 0)
}

/**
 * Calls method `index` of the COM object `self`: its first field points to the vtable, whose
 * slot `index` holds the function; the object itself is the implicit first (`this`) argument.
 * `proto` is the koffi prototype of the method including that `this` parameter.
 */
export function vtableCall(
  koffi: ComKoffi,
  self: bigint,
  index: number,
  proto: unknown,
  ...args: unknown[]
): unknown {
  if (!self) throw new Error(`vtable call ${index} on a null COM object`)
  const vtable = koffi.decode(self, 0, 'void *') as bigint
  const fn = koffi.decode(vtable, index * POINTER_SIZE, 'void *') as bigint
  return koffi.call(fn, proto, self, ...args)
}

const GUID_PATTERN =
  /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i

/**
 * A GUID's 16-byte in-memory layout: Data1 (u32), Data2 and Data3 (u16) little-endian, then
 * Data4 as the remaining 8 bytes in text order.
 */
export function parseGuid(text: string): Buffer {
  const match = GUID_PATTERN.exec(text.trim())
  if (!match) throw new Error(`malformed GUID: ${text}`)
  const [, data1, data2, data3, data4a, data4b] = match
  const guid = Buffer.alloc(16)
  guid.writeUInt32LE(parseInt(data1, 16), 0)
  guid.writeUInt16LE(parseInt(data2, 16), 4)
  guid.writeUInt16LE(parseInt(data3, 16), 6)
  Buffer.from(data4a + data4b, 'hex').copy(guid, 8)
  return guid
}

/** The ole32 entry points the runtime uses, plus a UTF-16 decoder and IUnknown's Release. */
export interface Ole32 {
  CoInitializeEx(reserved: null, coinit: number): number
  CoCreateInstance(
    clsid: Buffer,
    outer: null,
    context: number,
    iid: Buffer,
    out: [bigint | null]
  ): number
  CoTaskMemFree(pointer: bigint): void
  /** A NUL-terminated UTF-16 string at `pointer`. */
  decodeString(pointer: bigint): string
  /** The koffi prototype of `ULONG IUnknown::Release(this)`. */
  releaseProto: unknown
  /** The koffi prototype of `HRESULT IUnknown::QueryInterface(this, REFIID, void **)`. */
  queryInterfaceProto: unknown
}

export interface ComRuntime {
  /** Joins this thread's apartment (once; later calls do nothing). Throws when COM refuses. */
  init(): void
  /** CoCreateInstance(clsid, CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER) for interface `iid`. */
  createInstance(clsid: string, iid: string): bigint
  /** IUnknown::Release. */
  release(self: bigint): void
  /** IUnknown::QueryInterface for `iid`; null when the object does not implement it. */
  queryInterface(self: bigint, iid: string): bigint | null
  /** Reads a `CoTaskMemAlloc`ed out-string and frees it; null for a null pointer. */
  takeString(pointer: bigint | null): string | null
  /** `vtableCall`, returning the method's HRESULT. */
  call(self: bigint, index: number, proto: unknown, ...args: unknown[]): number
}

/** The real ole32 through koffi (Windows only; never loaded by the headless suite). */
export function loadOle32(koffi: Koffi): Ole32 {
  const ole32 = koffi.load('ole32.dll')
  return {
    CoInitializeEx: ole32.func('long __stdcall CoInitializeEx(void *reserved, uint32_t coinit)'),
    CoCreateInstance: ole32.func(
      'long __stdcall CoCreateInstance(void *clsid, void *outer, uint32_t context, void *iid, _Out_ void **object)'
    ),
    CoTaskMemFree: ole32.func('void __stdcall CoTaskMemFree(void *pointer)'),
    decodeString: (pointer) => koffi.decode(pointer, 'char16_t', -1) as string,
    releaseProto: koffi.proto('__stdcall', null, 'uint32_t', ['void *']),
    queryInterfaceProto: koffi.proto('__stdcall', null, 'long', [
      'void *',
      'void *',
      koffi.out(koffi.pointer('void *'))
    ])
  }
}

/**
 * COM for the calling thread. The apartment is joined lazily, once: Chromium has usually made
 * the main thread an STA already (S_FALSE), and RPC_E_CHANGED_MODE also leaves COM usable. The
 * apartment is never left: Taskyard uses COM until the process exits.
 */
export function createComRuntime(koffi: ComKoffi, ole32: Ole32): ComRuntime {
  let initialized = false
  const ensureApartment = (): void => {
    if (initialized) return
    const hr = ole32.CoInitializeEx(null, COINIT_APARTMENTTHREADED)
    if (hr !== RPC_E_CHANGED_MODE) checkHr(hr, 'CoInitializeEx')
    initialized = true
  }

  return {
    init: ensureApartment,

    createInstance(clsid, iid) {
      ensureApartment()
      const out: [bigint | null] = [null]
      const hr = ole32.CoCreateInstance(
        parseGuid(clsid),
        null,
        CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER,
        parseGuid(iid),
        out
      )
      checkHr(hr, 'CoCreateInstance')
      if (!out[0]) throw new ComError('CoCreateInstance returned no object', hr)
      return out[0]
    },

    release(self) {
      vtableCall(koffi, self, IUNKNOWN_RELEASE, ole32.releaseProto)
    },

    queryInterface(self, iid) {
      const out: [bigint | null] = [null]
      const hr = vtableCall(
        koffi,
        self,
        IUNKNOWN_QUERY_INTERFACE,
        ole32.queryInterfaceProto,
        parseGuid(iid),
        out
      ) as number
      return (hr | 0) >= 0 && out[0] ? out[0] : null
    },

    takeString(pointer) {
      if (!pointer) return null
      try {
        return ole32.decodeString(pointer)
      } finally {
        ole32.CoTaskMemFree(pointer)
      }
    },

    call: (self, index, proto, ...args) => vtableCall(koffi, self, index, proto, ...args) as number
  }
}

/** CoGetApartmentType: the thread is an STA / the main STA (both fine for the shell's UI objects). */
export const APTTYPE_STA = 0
export const APTTYPE_MAINSTA = 3

/** The ole32 calls `initOleApartment` needs. */
export interface OleApartmentCalls {
  OleInitialize(reserved: null): number
  CoGetApartmentType(type: [number], qualifier: [number]): number
}

/**
 * Makes this thread an OLE single-threaded apartment: `OleInitialize` (COM STA plus the OLE
 * clipboard and drag and drop, which Copy, Cut and Paste in shell menus use), then checks with
 * `CoGetApartmentType` that the thread really is an STA. Throws otherwise (a thread already in
 * the multithreaded apartment cannot host shell menus).
 */
export function initOleApartment(ole: OleApartmentCalls): void {
  checkHr(ole.OleInitialize(null), 'OleInitialize')
  const type: [number] = [-1]
  const qualifier: [number] = [0]
  checkHr(ole.CoGetApartmentType(type, qualifier), 'CoGetApartmentType')
  if (type[0] !== APTTYPE_STA && type[0] !== APTTYPE_MAINSTA) {
    throw new ComError(`the thread is not a single-threaded apartment (APTTYPE ${type[0]})`, 0)
  }
}
