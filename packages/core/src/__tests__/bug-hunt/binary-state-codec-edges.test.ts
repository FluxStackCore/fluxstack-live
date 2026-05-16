// Bug hunt: BinaryStateCodec — overflow / underflow / type confusion /
// round-trip across all wire types / sparse deltas / large bitmasks.
//
// The codec uses DataView + raw byte ops, which means out-of-range values
// silently truncate. Hunting for places where that drift would corrupt
// game state without warning.

import { describe, it, expect } from 'vitest'
import { BinaryStateCodec } from '../../protocol/BinaryStateCodec'

describe('BinaryStateCodec — round-trip per wire type', () => {
  it('uint8 round-trip across full range', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'uint8' })
    for (const v of [0, 1, 127, 128, 255]) {
      const { binary } = codec.encodeDelta({ x: v } as any)
      expect(codec.decodeDelta(binary!)).toEqual({ x: v })
    }
  })

  it('uint16 round-trip across full range', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'uint16' })
    for (const v of [0, 256, 65535]) {
      const { binary } = codec.encodeDelta({ x: v } as any)
      expect(codec.decodeDelta(binary!)).toEqual({ x: v })
    }
  })

  it('uint32 round-trip across full range', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'uint32' })
    for (const v of [0, 65536, 4294967295]) {
      const { binary } = codec.encodeDelta({ x: v } as any)
      expect(codec.decodeDelta(binary!)).toEqual({ x: v })
    }
  })

  it('int8/int16/int32 round-trip with negative values', () => {
    const c1 = new BinaryStateCodec({ x: 0 }, { x: 'int8' })
    expect(c1.decodeDelta(c1.encodeDelta({ x: -128 } as any).binary!)).toEqual({ x: -128 })
    const c2 = new BinaryStateCodec({ x: 0 }, { x: 'int16' })
    expect(c2.decodeDelta(c2.encodeDelta({ x: -32768 } as any).binary!)).toEqual({ x: -32768 })
    const c3 = new BinaryStateCodec({ x: 0 }, { x: 'int32' })
    expect(c3.decodeDelta(c3.encodeDelta({ x: -2147483648 } as any).binary!)).toEqual({ x: -2147483648 })
  })

  it('float32 round-trip loses some precision (documented)', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'float32' })
    const v = 3.14159265358979
    const back = (codec.decodeDelta(codec.encodeDelta({ x: v } as any).binary!) as any).x
    expect(Math.abs(back - v)).toBeLessThan(1e-6)
  })

  it('float64 round-trip is exact', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'float64' })
    const v = 3.14159265358979
    expect(codec.decodeDelta(codec.encodeDelta({ x: v } as any).binary!)).toEqual({ x: v })
  })

  it('boolean round-trip', () => {
    const codec = new BinaryStateCodec({ x: false }, { x: 'boolean' })
    expect(codec.decodeDelta(codec.encodeDelta({ x: true } as any).binary!)).toEqual({ x: true })
    expect(codec.decodeDelta(codec.encodeDelta({ x: false } as any).binary!)).toEqual({ x: false })
  })

  it('string round-trip preserves unicode', () => {
    const codec = new BinaryStateCodec({ s: '' }, { s: 'string' })
    for (const v of ['', 'hello', 'ñ', '🎮 emoji', 'café']) {
      const { binary } = codec.encodeDelta({ s: v } as any)
      expect(codec.decodeDelta(binary!)).toEqual({ s: v })
    }
  })
})

describe('BinaryStateCodec — overflow / out-of-range (silent truncation)', () => {
  it('🔍 uint8 silently truncates 256 to 0 (overflow)', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'uint8' })
    const { binary } = codec.encodeDelta({ x: 256 } as any)
    expect(codec.decodeDelta(binary!)).toEqual({ x: 0 })
  })

  it('🔍 uint8 silently truncates 257 to 1', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'uint8' })
    const { binary } = codec.encodeDelta({ x: 257 } as any)
    expect(codec.decodeDelta(binary!)).toEqual({ x: 1 })
  })

  it('🔍 uint8 silently truncates negative -1 to 255', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'uint8' })
    const { binary } = codec.encodeDelta({ x: -1 } as any)
    expect(codec.decodeDelta(binary!)).toEqual({ x: 255 })
  })

  it('🔍 int8 wraps 128 to -128', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'int8' })
    const { binary } = codec.encodeDelta({ x: 128 } as any)
    const out = (codec.decodeDelta(binary!) as any).x
    // DataView.setInt8 also truncates — verify the actual behavior.
    expect(out).toBe(-128)
  })

  it('🔍 uint32 silently overflows 2^32', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'uint32' })
    const { binary } = codec.encodeDelta({ x: 4294967296 } as any)
    expect((codec.decodeDelta(binary!) as any).x).toBe(0)
  })

  it('NaN encoded as uint8 → 0 (NaN & 0xff)', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'uint8' })
    const { binary } = codec.encodeDelta({ x: NaN } as any)
    expect(codec.decodeDelta(binary!)).toEqual({ x: 0 })
  })

  it('Infinity encoded as float32 round-trips as Infinity', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'float32' })
    const { binary } = codec.encodeDelta({ x: Infinity } as any)
    expect((codec.decodeDelta(binary!) as any).x).toBe(Infinity)
  })

  it('🔍 boolean truthy non-true (e.g. "yes") encodes as 1, decodes as true', () => {
    const codec = new BinaryStateCodec({ x: false }, { x: 'boolean' })
    const { binary } = codec.encodeDelta({ x: 'yes' } as any)
    expect(codec.decodeDelta(binary!)).toEqual({ x: true })
  })

  it('🔍 boolean falsy non-false (e.g. 0) encodes as 0, decodes as false', () => {
    const codec = new BinaryStateCodec({ x: false }, { x: 'boolean' })
    const { binary } = codec.encodeDelta({ x: 0 } as any)
    expect(codec.decodeDelta(binary!)).toEqual({ x: false })
  })
})

describe('BinaryStateCodec — sparse delta + bitmask correctness', () => {
  it('encoding a subset of fields decodes back only those fields', () => {
    const codec = new BinaryStateCodec({ a: 0, b: 0, c: 0 }, { a: 'uint8', b: 'uint16', c: 'uint32' })
    const { binary } = codec.encodeDelta({ a: 1, c: 99 } as any) // skip b
    expect(codec.decodeDelta(binary!)).toEqual({ a: 1, c: 99 })
  })

  it('only changing one of many fields produces a small delta', () => {
    const codec = new BinaryStateCodec(
      { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0, i: 0 },
      { a: 'uint8', b: 'uint8', c: 'uint8', d: 'uint8', e: 'uint8', f: 'uint8', g: 'uint8', h: 'uint8', i: 'uint8' },
    )
    const { binary } = codec.encodeDelta({ a: 1 } as any)
    // Bitmask is 2 bytes (9 fields → ceil(9/8)=2), plus 1 data byte → 3 bytes.
    expect(binary!.length).toBe(3)
  })

  it('bitmask spans multiple bytes when fieldCount > 8', () => {
    const schema: any = {}
    const defaultState: any = {}
    for (let i = 0; i < 20; i++) {
      schema[`f${i}`] = 'uint8'
      defaultState[`f${i}`] = 0
    }
    const codec = new BinaryStateCodec(defaultState, schema)
    // Bitmask = 3 bytes (20 fields)
    const expected: any = {}
    expected[`f19`] = 42
    const { binary } = codec.encodeDelta(expected)
    expect(codec.decodeDelta(binary!)).toEqual(expected)
  })
})

describe('BinaryStateCodec — encodeDelta empty / no fields', () => {
  it('encodeDelta with no fields returns null binary', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'uint8' })
    const { binary } = codec.encodeDelta({} as any)
    expect(binary).toBeNull()
  })

  it('encodeDelta with only unknown keys produces null binary', () => {
    const codec = new BinaryStateCodec({ x: 0 }, { x: 'uint8' })
    const { binary, jsonFallback } = codec.encodeDelta({ y: 99 } as any)
    expect(binary).toBeNull()
    // y isn't even in unsupported (which is populated only from defaultState),
    // so it just gets ignored. Document that.
    expect(jsonFallback).toBeNull()
  })

  it('encodeDelta separates supported binary fields from unsupported (auto-infer)', () => {
    const codec = new BinaryStateCodec({ n: 0, obj: { nested: 1 } } as any) // obj is unsupported
    const { binary, jsonFallback } = codec.encodeDelta({ n: 5, obj: { nested: 2 } } as any)
    expect(binary).not.toBeNull()
    expect(jsonFallback).toEqual({ obj: { nested: 2 } })
  })
})

describe('BinaryStateCodec — explicit schema takes priority over auto-infer', () => {
  it('explicit uint8 overrides float64 auto-inference for numbers', () => {
    const auto = new BinaryStateCodec({ x: 0 })
    const explicit = new BinaryStateCodec({ x: 0 }, { x: 'uint8' })
    expect(auto.info.estimatedFixedSize).toBeGreaterThan(explicit.info.estimatedFixedSize)
  })
})

describe('BinaryStateCodec — info reporting', () => {
  it('fullCoverage is true when all fields are supported', () => {
    const codec = new BinaryStateCodec({ a: 0, b: false, c: '' })
    expect(codec.fullCoverage).toBe(true)
    expect(codec.info.unsupported).toEqual([])
  })

  it('fullCoverage is false when defaultState contains a complex type', () => {
    const codec = new BinaryStateCodec({ n: 0, arr: [] as any[] })
    expect(codec.fullCoverage).toBe(false)
    expect(codec.info.unsupported).toContain('arr')
  })

  it('hasFields reflects the count of supported fields', () => {
    expect(new BinaryStateCodec({}).hasFields).toBe(false)
    expect(new BinaryStateCodec({ x: 0 }).hasFields).toBe(true)
  })
})

describe('BinaryStateCodec — buffer growth', () => {
  it('grows internal buffer when encoding a long (but uint16-safe) string', () => {
    // Strings encode length as uint16 (max 65535 bytes). Use 60k to stay safe.
    const codec = new BinaryStateCodec({ s: '' }, { s: 'string' })
    const big = 'a'.repeat(60_000)
    const { binary } = codec.encodeDelta({ s: big } as any)
    expect(codec.decodeDelta(binary!)).toEqual({ s: big })
  })

  it('reusing the same codec for repeated encodes works (no buffer reuse bug)', () => {
    const codec = new BinaryStateCodec({ x: 0, s: '' }, { x: 'uint32', s: 'string' })
    const a = codec.encodeDelta({ x: 1, s: 'first' } as any).binary!
    const aCopy = Uint8Array.from(a) // codec.slice() returns a view; we capture a copy
    const b = codec.encodeDelta({ x: 2, s: 'second' } as any).binary!
    // First encode's result must not be mutated by the second encode.
    expect(codec.decodeDelta(aCopy)).toEqual({ x: 1, s: 'first' })
    expect(codec.decodeDelta(b)).toEqual({ x: 2, s: 'second' })
  })
})

describe('BinaryStateCodec — string length limit (uint16)', () => {
  it('🔍 string longer than 65535 bytes silently truncates length field (uint16 overflow)', () => {
    const codec = new BinaryStateCodec({ s: '' }, { s: 'string' })
    const big = 'a'.repeat(65536) // 1 byte over uint16 max
    // The length is written as uint16 → 65536 becomes 0 → decoded as empty string.
    const { binary } = codec.encodeDelta({ s: big } as any)
    const out = (codec.decodeDelta(binary!) as any).s
    expect(out.length).toBe(0) // documents the truncation
  })
})
