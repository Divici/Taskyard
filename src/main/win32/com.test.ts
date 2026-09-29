import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  checkHr,
  ComError,
  createComRuntime,
  hresultHex,
  initOleApartment,
  parseGuid,
  POINTER_SIZE,
  RPC_E_CHANGED_MODE,
  S_FALSE,
  vtableCall,
  type ComKoffi,
  type Ole32
} from './com'

/**
 * Headless: a fake koffi whose "memory" maps addresses to pointers, so a COM object's vtable can
 * be laid out by hand. The real thing runs in com.win32.test.ts (npm run test:win32).
 */
function fakeMemory(): {
  koffi: ComKoffi
  memory: Map<bigint, bigint>
  calls: { fn: bigint; proto: unknown; args: unknown[] }[]
  results: Map<bigint, unknown>
  /** Lays out an object whose vtable has `methods` entries; returns its address. */
  object(address: bigint, methods: number): bigint
} {
  const memory = new Map<bigint, bigint>()
  const calls: { fn: bigint; proto: unknown; args: unknown[] }[] = []
  const results = new Map<bigint, unknown>()
  const koffi: ComKoffi = {
    decode: vi.fn((pointer: bigint, offset: number, type: string) => {
      expect(type).toBe('void *')
      const value = memory.get(pointer + BigInt(offset))
      if (value === undefined)
        throw new Error(`segfault at 0x${(pointer + BigInt(offset)).toString(16)}`)
      return value
    }),
    call: vi.fn((fn: bigint, proto: unknown, ...args: unknown[]) => {
      calls.push({ fn, proto, args })
      return results.get(fn) ?? 0
    })
  }
  return {
    koffi,
    memory,
    calls,
    results,
    object(address, methods) {
      const vtable = address + 0x1000n
      memory.set(address, vtable)
      for (let i = 0; i < methods; i++) {
        memory.set(vtable + BigInt(i * POINTER_SIZE), 0xf000n + address + BigInt(i))
      }
      return address
    }
  }
}

describe('vtableCall', () => {
  it('calls method N through the object vtable, passing the object as `this`', () => {
    const mem = fakeMemory()
    const self = mem.object(0x5000n, 19)
    mem.results.set(0xf000n + 0x5000n + 6n, 0)
    const proto = { name: 'GetMonitorDevicePathCount' }
    const out: [number] = [0]

    const hr = vtableCall(mem.koffi, self, 6, proto, out)

    expect(hr).toBe(0)
    expect(mem.calls).toEqual([{ fn: 0xf000n + 0x5000n + 6n, proto, args: [self, out] }])
  })

  it('reads the vtable pointer at offset 0 and the slot at index × pointer size', () => {
    const mem = fakeMemory()
    const self = mem.object(0x8000n, 12)
    vtableCall(mem.koffi, self, 11, 'proto')
    expect(mem.koffi.decode).toHaveBeenNthCalledWith(1, self, 0, 'void *')
    expect(mem.koffi.decode).toHaveBeenNthCalledWith(2, 0x9000n, 11 * POINTER_SIZE, 'void *')
    expect(mem.calls[0].fn).toBe(0xf000n + 0x8000n + 11n)
  })

  it('refuses a null object instead of reading address 0', () => {
    const mem = fakeMemory()
    expect(() => vtableCall(mem.koffi, 0n, 2, 'proto')).toThrow(/null COM object/)
    expect(mem.koffi.decode).not.toHaveBeenCalled()
  })
})

describe('parseGuid', () => {
  it('lays a GUID out as Data1..3 little-endian and Data4 as bytes', () => {
    const guid = parseGuid('{C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD}')
    expect(guid.toString('hex')).toBe('1031cfc20e46c14fb9d08a1c0c9cc4bd')
  })

  it('accepts a GUID without braces and rejects malformed text', () => {
    expect(parseGuid('B92B56A9-8B55-4E14-9A89-0199BBB6F93B').toString('hex')).toBe(
      'a9562bb9558b144e9a890199bbb6f93b'
    )
    expect(() => parseGuid('{not-a-guid}')).toThrow(/malformed GUID/)
  })
})

describe('checkHr', () => {
  it('passes S_OK and S_FALSE, throws a ComError with the HRESULT for failures', () => {
    expect(() => checkHr(0, 'x')).not.toThrow()
    expect(() => checkHr(S_FALSE, 'x')).not.toThrow()
    const error = (() => {
      try {
        checkHr(0x80070490 | 0, 'GetMonitorRECT')
      } catch (e) {
        return e
      }
      return null
    })()
    expect(error).toBeInstanceOf(ComError)
    expect((error as ComError).hresult).toBe(0x80070490 | 0)
    expect((error as ComError).message).toContain('GetMonitorRECT failed: HRESULT 0x80070490')
    expect(hresultHex(-2147024809)).toBe('0x80070057')
  })
})

describe('createComRuntime', () => {
  function fakeOle32(overrides: Partial<Ole32> = {}): Ole32 {
    return {
      CoInitializeEx: vi.fn(() => 0),
      CoCreateInstance: vi.fn((_clsid, _outer, _context, _iid, out: [bigint | null]) => {
        out[0] = 0x7000n
        return 0
      }),
      CoTaskMemFree: vi.fn(),
      decodeString: vi.fn(() => 'text'),
      releaseProto: 'IUnknown::Release',
      queryInterfaceProto: 'IUnknown::QueryInterface',
      ...overrides
    }
  }

  it('initializes COM once (apartment-threaded) and creates in-process instances', () => {
    const mem = fakeMemory()
    const ole32 = fakeOle32()
    const com = createComRuntime(mem.koffi, ole32)

    expect(
      com.createInstance(
        '{C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD}',
        '{B92B56A9-8B55-4E14-9A89-0199BBB6F93B}'
      )
    ).toBe(0x7000n)
    com.createInstance(
      '{C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD}',
      '{B92B56A9-8B55-4E14-9A89-0199BBB6F93B}'
    )

    expect(ole32.CoInitializeEx).toHaveBeenCalledTimes(1)
    expect(ole32.CoInitializeEx).toHaveBeenCalledWith(null, 0x2)
    const [clsid, outer, context, iid] = vi.mocked(ole32.CoCreateInstance).mock.calls[0]
    expect((clsid as Buffer).toString('hex')).toBe('1031cfc20e46c14fb9d08a1c0c9cc4bd')
    expect(outer).toBeNull()
    expect(context).toBe(0x1 | 0x4) // CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER
    expect((iid as Buffer).toString('hex')).toBe('a9562bb9558b144e9a890199bbb6f93b')
  })

  it('works on a thread Chromium already put in another apartment (RPC_E_CHANGED_MODE)', () => {
    const mem = fakeMemory()
    const com = createComRuntime(
      mem.koffi,
      fakeOle32({ CoInitializeEx: vi.fn(() => RPC_E_CHANGED_MODE) })
    )
    expect(
      com.createInstance(
        '{C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD}',
        '{B92B56A9-8B55-4E14-9A89-0199BBB6F93B}'
      )
    ).toBe(0x7000n)
  })

  it('throws a ComError when CoCreateInstance fails or returns no object', () => {
    const mem = fakeMemory()
    const failing = createComRuntime(
      mem.koffi,
      fakeOle32({ CoCreateInstance: vi.fn(() => 0x80040154 | 0) })
    )
    expect(() =>
      failing.createInstance(
        '{C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD}',
        '{B92B56A9-8B55-4E14-9A89-0199BBB6F93B}'
      )
    ).toThrow(/CoCreateInstance failed: HRESULT 0x80040154/)
    const empty = createComRuntime(mem.koffi, fakeOle32({ CoCreateInstance: vi.fn(() => 0) }))
    expect(() =>
      empty.createInstance(
        '{C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD}',
        '{B92B56A9-8B55-4E14-9A89-0199BBB6F93B}'
      )
    ).toThrow(/no object/)
  })

  it('releases through IUnknown::Release (vtable slot 2)', () => {
    const mem = fakeMemory()
    const self = mem.object(0x7000n, 3)
    const com = createComRuntime(mem.koffi, fakeOle32())
    com.release(self)
    expect(mem.calls.map((call) => call.fn)).toEqual([0xf000n + 0x7000n + 2n])
    expect(mem.calls[0].proto).toBe('IUnknown::Release')
    expect(mem.calls[0].args).toEqual([self])
  })

  it('reads a CoTaskMemAlloc string and frees it; null stays null', () => {
    const mem = fakeMemory()
    const ole32 = fakeOle32({ decodeString: vi.fn(() => 'C:\\wall.jpg') })
    const com = createComRuntime(mem.koffi, ole32)
    expect(com.takeString(0x1234n)).toBe('C:\\wall.jpg')
    expect(ole32.CoTaskMemFree).toHaveBeenCalledWith(0x1234n)
    expect(com.takeString(null)).toBeNull()
    expect(ole32.CoTaskMemFree).toHaveBeenCalledTimes(1)
  })

  it('joins the apartment once on init(), shared with createInstance', () => {
    const mem = fakeMemory()
    const ole32 = fakeOle32({ CoInitializeEx: vi.fn(() => S_FALSE) })
    const com = createComRuntime(mem.koffi, ole32)
    com.init()
    com.init()
    com.createInstance(
      '{C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD}',
      '{B92B56A9-8B55-4E14-9A89-0199BBB6F93B}'
    )
    expect(ole32.CoInitializeEx).toHaveBeenCalledTimes(1)
    const refused = createComRuntime(
      mem.koffi,
      fakeOle32({ CoInitializeEx: vi.fn(() => 0x8007000e | 0) })
    )
    expect(() => refused.init()).toThrow(/CoInitializeEx failed: HRESULT 0x8007000e/)
  })

  it('queries another interface through IUnknown::QueryInterface (slot 0); null when unsupported', () => {
    const mem = fakeMemory()
    const self = mem.object(0x7000n, 3)
    const com = createComRuntime(mem.koffi, fakeOle32())
    vi.mocked(mem.koffi.call).mockImplementation((_fn, _proto, ...args: unknown[]) => {
      const [, iid, out] = args as [bigint, Buffer, [bigint | null]]
      if (iid.equals(parseGuid('{BCFCE0A0-EC17-11D0-8D10-00A0C90F2719}'))) {
        out[0] = 0x7300n
        return 0
      }
      return 0x80004002 | 0 // E_NOINTERFACE
    })
    expect(com.queryInterface(self, '{BCFCE0A0-EC17-11D0-8D10-00A0C90F2719}')).toBe(0x7300n)
    expect(com.queryInterface(self, '{000214F4-0000-0000-C000-000000000046}')).toBeNull()
    const [first] = vi.mocked(mem.koffi.call).mock.calls
    expect(first[0]).toBe(0xf000n + 0x7000n + 0n)
    expect(first[1]).toBe('IUnknown::QueryInterface')
  })

  it('frees the string even when decoding it throws', () => {
    const mem = fakeMemory()
    const ole32 = fakeOle32({
      decodeString: vi.fn(() => {
        throw new Error('bad memory')
      })
    })
    const com = createComRuntime(mem.koffi, ole32)
    expect(() => com.takeString(0x99n)).toThrow('bad memory')
    expect(ole32.CoTaskMemFree).toHaveBeenCalledWith(0x99n)
  })
})

describe('initOleApartment (the shell-menu helper: OLE clipboard for Copy, Cut and Paste)', () => {
  const ole = (
    hr: number,
    apartment: number
  ): { OleInitialize: Mock; CoGetApartmentType: Mock } => ({
    OleInitialize: vi.fn(() => hr),
    CoGetApartmentType: vi.fn((type: [number], qualifier: [number]) => {
      type[0] = apartment
      qualifier[0] = 0
      return 0
    })
  })

  it('initializes OLE and accepts a single-threaded apartment (STA or the main STA)', () => {
    const fresh = ole(0, 0)
    initOleApartment(fresh)
    expect(fresh.OleInitialize).toHaveBeenCalledWith(null)
    expect(() => initOleApartment(ole(S_FALSE, 3))).not.toThrow()
  })

  it('refuses a thread already in the multithreaded apartment', () => {
    expect(() => initOleApartment(ole(RPC_E_CHANGED_MODE, 1))).toThrow(
      /OleInitialize failed: HRESULT 0x80010106/
    )
  })

  it('refuses when the apartment is not single-threaded after all', () => {
    expect(() => initOleApartment(ole(0, 1))).toThrow(
      /not a single-threaded apartment \(APTTYPE 1\)/
    )
  })
})
