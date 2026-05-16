// @fluxstack/live - Binary State Codec
//
// Auto-generates a DataView-based encoder/decoder from a component's defaultState.
// Zero-copy, zero-GC, fixed-layout binary encoding for state deltas.
//
// Two modes:
//   1. Auto-infer: `static binaryState = true` → types inferred from defaultState
//   2. Explicit:   `static binaryState = { hp: 'uint8', x: 'float32', name: 'string' }`
//      → dev picks optimal wire types for maximum byte savings
//
// Layout: [bitmask (1-4 bytes)] [field values in schema order]
//
// Wire types and sizes:
//   uint8    → 1 byte  (0-255)                    — HP, level, flags
//   uint16   → 2 bytes (0-65535)                   — item counts, ports
//   uint32   → 4 bytes (0-4294967295)              — scores, timestamps (32-bit)
//   int8     → 1 byte  (-128 to 127)               — directions, small offsets
//   int16    → 2 bytes (-32768 to 32767)            — tile coords, small positions
//   int32    → 4 bytes (-2147483648 to 2147483647)  — large positions
//   float32  → 4 bytes (±3.4e38, ~7 digits)        — game positions, rotations
//   float64  → 8 bytes (±1.8e308, ~15 digits)      — precise math, timestamps
//   boolean  → 1 byte  (0 or 1)                    — flags
//   string   → 2 bytes len + utf8 bytes             — names, messages

const _enc = new TextEncoder()
const _dec = new TextDecoder()

// Field type tags (must match between server and client)
const TYPE_UINT8    = 0
const TYPE_UINT16   = 1
const TYPE_UINT32   = 2
const TYPE_INT8     = 3
const TYPE_INT16    = 4
const TYPE_INT32    = 5
const TYPE_FLOAT32  = 6
const TYPE_FLOAT64  = 7
const TYPE_BOOLEAN  = 8
const TYPE_STRING   = 9

type WireType = typeof TYPE_UINT8 | typeof TYPE_UINT16 | typeof TYPE_UINT32 |
  typeof TYPE_INT8 | typeof TYPE_INT16 | typeof TYPE_INT32 |
  typeof TYPE_FLOAT32 | typeof TYPE_FLOAT64 | typeof TYPE_BOOLEAN | typeof TYPE_STRING

/** Explicit wire type names the dev can use in binaryState config */
export type BinaryFieldType =
  'uint8' | 'uint16' | 'uint32' |
  'int8' | 'int16' | 'int32' |
  'float32' | 'float64' |
  'boolean' | 'string'

/** binaryState config: true (auto-infer) or explicit field types */
export type BinaryStateConfig = true | Record<string, BinaryFieldType>

const TYPE_NAME_MAP: Record<BinaryFieldType, WireType> = {
  uint8: TYPE_UINT8, uint16: TYPE_UINT16, uint32: TYPE_UINT32,
  int8: TYPE_INT8, int16: TYPE_INT16, int32: TYPE_INT32,
  float32: TYPE_FLOAT32, float64: TYPE_FLOAT64,
  boolean: TYPE_BOOLEAN, string: TYPE_STRING,
}

const WIRE_SIZES: Record<WireType, number> = {
  [TYPE_UINT8]: 1, [TYPE_UINT16]: 2, [TYPE_UINT32]: 4,
  [TYPE_INT8]: 1, [TYPE_INT16]: 2, [TYPE_INT32]: 4,
  [TYPE_FLOAT32]: 4, [TYPE_FLOAT64]: 8,
  [TYPE_BOOLEAN]: 1, [TYPE_STRING]: 0, // variable
}

interface FieldDef {
  name: string
  wireType: WireType
  fixedSize: number
}

export interface BinaryCodecInfo {
  fieldCount: number
  fields: string[]
  unsupported: string[]
  fullCoverage: boolean
  /** Estimated bytes per full state encode (fixed fields only, excludes strings) */
  estimatedFixedSize: number
}

export class BinaryStateCodec<TState = Record<string, any>> {
  private readonly _fields: FieldDef[]
  private readonly _fieldIndex: Map<string, number>
  private readonly _unsupported: string[]
  private readonly _bitmaskBytes: number
  private _encodeBuf: Uint8Array
  private _encodeView: DataView
  /** Reused per encode — avoids one Uint8Array allocation per call. */
  private _bitmaskScratch: Uint8Array
  /** Reused per encode — avoids one array allocation per call when strings present. */
  private _strBytesScratch: (Uint8Array | null)[]

  /**
   * Create a codec from defaultState.
   *
   * @param defaultState — the component's defaultState object
   * @param schema — optional explicit field types. When omitted, types are inferred:
   *   - `typeof val === 'number'` → float64
   *   - `typeof val === 'boolean'` → boolean
   *   - `typeof val === 'string'` → string
   *   - anything else → unsupported (JSON fallback)
   */
  constructor(defaultState: TState, schema?: Record<string, BinaryFieldType>) {
    this._fields = []
    this._fieldIndex = new Map()
    this._unsupported = []

    const state = defaultState as Record<string, any>
    const keys = Object.keys(state)

    for (const key of keys) {
      // Explicit schema takes priority
      if (schema && key in schema) {
        const wireType = TYPE_NAME_MAP[schema[key]]
        this._fieldIndex.set(key, this._fields.length)
        this._fields.push({ name: key, wireType, fixedSize: WIRE_SIZES[wireType] })
        continue
      }

      // Auto-infer from value type
      const val = state[key]
      const t = typeof val

      if (t === 'number') {
        this._fieldIndex.set(key, this._fields.length)
        this._fields.push({ name: key, wireType: TYPE_FLOAT64, fixedSize: 8 })
      } else if (t === 'boolean') {
        this._fieldIndex.set(key, this._fields.length)
        this._fields.push({ name: key, wireType: TYPE_BOOLEAN, fixedSize: 1 })
      } else if (t === 'string') {
        this._fieldIndex.set(key, this._fields.length)
        this._fields.push({ name: key, wireType: TYPE_STRING, fixedSize: 0 })
      } else {
        this._unsupported.push(key)
      }
    }

    this._bitmaskBytes = Math.ceil(this._fields.length / 8) || 1

    const maxFixed = this._fields.reduce((sum, f) => sum + (f.fixedSize || 258), 0)
    const initialSize = this._bitmaskBytes + maxFixed + 4096
    this._encodeBuf = new Uint8Array(initialSize)
    this._encodeView = new DataView(this._encodeBuf.buffer)
    // Pre-allocate per-encode scratch — reused across encodeDelta calls.
    this._bitmaskScratch = new Uint8Array(this._bitmaskBytes)
    this._strBytesScratch = new Array(this._fields.length).fill(null)
  }

  get info(): BinaryCodecInfo {
    return {
      fieldCount: this._fields.length,
      fields: this._fields.map(f => f.name),
      unsupported: [...this._unsupported],
      fullCoverage: this._unsupported.length === 0,
      estimatedFixedSize: this._bitmaskBytes + this._fields.reduce((s, f) => s + (f.fixedSize || 0), 0),
    }
  }

  get fullCoverage(): boolean { return this._unsupported.length === 0 }
  get hasFields(): boolean { return this._fields.length > 0 }

  /**
   * Encode a state delta into a compact binary buffer.
   * Returns `binary` for supported fields, `jsonFallback` for unsupported fields.
   */
  encodeDelta(delta: Partial<TState>): {
    binary: Uint8Array | null
    jsonFallback: Record<string, any> | null
  } {
    const d = delta as Record<string, any>
    let jsonFallback: Record<string, any> | null = null
    let hasBinary = false

    // Reuse the scratch bitmask — zero it first.
    const bitmask = this._bitmaskScratch
    for (let i = 0; i < bitmask.length; i++) bitmask[i] = 0
    // Reuse the scratch string-bytes array — null entries are skipped.
    const strBytes = this._strBytesScratch

    for (const key of Object.keys(d)) {
      const idx = this._fieldIndex.get(key)
      if (idx !== undefined) {
        bitmask[idx >> 3] |= (1 << (idx & 7))
        hasBinary = true
      } else if (this._unsupported.includes(key)) {
        if (!jsonFallback) jsonFallback = {}
        jsonFallback[key] = d[key]
      }
    }

    if (!hasBinary) return { binary: null, jsonFallback }

    // Calculate needed size — and CACHE the encoded bytes for strings so
    // we don't double-encode them in the write loop below.
    let neededSize = this._bitmaskBytes
    for (let i = 0; i < this._fields.length; i++) {
      if (!(bitmask[i >> 3] & (1 << (i & 7)))) {
        strBytes[i] = null
        continue
      }
      const field = this._fields[i]
      if (field.wireType === TYPE_STRING) {
        const enc = _enc.encode(d[field.name] as string)
        strBytes[i] = enc
        neededSize += 2 + enc.length
      } else {
        strBytes[i] = null
        neededSize += field.fixedSize
      }
    }

    if (neededSize > this._encodeBuf.length) {
      this._encodeBuf = new Uint8Array(neededSize * 2)
      this._encodeView = new DataView(this._encodeBuf.buffer)
    }

    // Write bitmask
    this._encodeBuf.set(bitmask, 0)
    let offset = this._bitmaskBytes

    // Write field values
    for (let i = 0; i < this._fields.length; i++) {
      if (!(bitmask[i >> 3] & (1 << (i & 7)))) continue
      const field = this._fields[i]
      const val = d[field.name]

      switch (field.wireType) {
        case TYPE_UINT8:
          this._encodeBuf[offset] = val & 0xff
          offset += 1
          break
        case TYPE_UINT16:
          this._encodeView.setUint16(offset, val, true)
          offset += 2
          break
        case TYPE_UINT32:
          this._encodeView.setUint32(offset, val, true)
          offset += 4
          break
        case TYPE_INT8:
          this._encodeView.setInt8(offset, val)
          offset += 1
          break
        case TYPE_INT16:
          this._encodeView.setInt16(offset, val, true)
          offset += 2
          break
        case TYPE_INT32:
          this._encodeView.setInt32(offset, val, true)
          offset += 4
          break
        case TYPE_FLOAT32:
          this._encodeView.setFloat32(offset, val, true)
          offset += 4
          break
        case TYPE_FLOAT64:
          this._encodeView.setFloat64(offset, val, true)
          offset += 8
          break
        case TYPE_BOOLEAN:
          this._encodeBuf[offset] = val ? 1 : 0
          offset += 1
          break
        case TYPE_STRING: {
          // Reuse the bytes we already encoded during size calculation.
          const enc = strBytes[i]!
          this._encodeView.setUint16(offset, enc.length, true)
          offset += 2
          this._encodeBuf.set(enc, offset)
          offset += enc.length
          break
        }
      }
    }

    return { binary: this._encodeBuf.slice(0, offset), jsonFallback }
  }

  /**
   * Decode a binary delta buffer back into a partial state object.
   */
  decodeDelta(buf: Uint8Array): Partial<TState> {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const result: Record<string, any> = {}
    let offset = this._bitmaskBytes

    for (let i = 0; i < this._fields.length; i++) {
      if (!(buf[i >> 3] & (1 << (i & 7)))) continue
      const field = this._fields[i]

      switch (field.wireType) {
        case TYPE_UINT8:
          result[field.name] = buf[offset]
          offset += 1
          break
        case TYPE_UINT16:
          result[field.name] = view.getUint16(offset, true)
          offset += 2
          break
        case TYPE_UINT32:
          result[field.name] = view.getUint32(offset, true)
          offset += 4
          break
        case TYPE_INT8:
          result[field.name] = view.getInt8(offset)
          offset += 1
          break
        case TYPE_INT16:
          result[field.name] = view.getInt16(offset, true)
          offset += 2
          break
        case TYPE_INT32:
          result[field.name] = view.getInt32(offset, true)
          offset += 4
          break
        case TYPE_FLOAT32:
          result[field.name] = view.getFloat32(offset, true)
          offset += 4
          break
        case TYPE_FLOAT64:
          result[field.name] = view.getFloat64(offset, true)
          offset += 8
          break
        case TYPE_BOOLEAN:
          result[field.name] = buf[offset] === 1
          offset += 1
          break
        case TYPE_STRING: {
          const len = view.getUint16(offset, true)
          offset += 2
          result[field.name] = _dec.decode(buf.subarray(offset, offset + len))
          offset += len
          break
        }
      }
    }

    return result as Partial<TState>
  }
}
