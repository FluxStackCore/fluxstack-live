// @fluxstack/live - Room Codec System
//
// Binary serialization for room messages. Built-in MessagePack codec (zero deps)
// with support for custom codecs.
//
// Wire format for binary room frames:
//   [frameType:u8][compIdLen:u8][compId:utf8][roomIdLen:u8][roomId:utf8][eventLen:u16BE][event:utf8][payload]
//
// Frame types:
//   0x01 = BINARY_STATE_DELTA (existing, component-level)
//   0x02 = BINARY_ROOM_EVENT
//   0x03 = BINARY_ROOM_STATE

// ===== Binary Frame Constants =====

export const BINARY_STATE_DELTA = 0x01
export const BINARY_ROOM_EVENT = 0x02
export const BINARY_ROOM_STATE = 0x03

// ===== Codec Interface =====

export interface RoomCodec {
  encode(data: unknown): Uint8Array
  decode(buf: Uint8Array): unknown
}

// ===== Built-in MessagePack Codec =====

// Lightweight msgpack encoder/decoder covering:
// null, boolean, int (positive fixint, negative fixint, uint8/16/32, int8/16/32),
// float64, string, binary (Uint8Array), array, map (plain objects).
// ~200 lines, zero external dependencies.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function msgpackEncode(value: unknown): Uint8Array {
  const parts: Uint8Array[] = []
  // `seen` tracks object/array references already on the current path to
  // detect circular references (fixes #7 H3). Without this, a circular
  // value would recurse until RangeError, and callers would either see a
  // cryptic stack overflow or — worse — a silently swallowed error in the
  // batcher.
  const seen = new Set<object>()
  encode(value, parts, seen)
  // Merge parts into a single buffer
  let totalLen = 0
  for (const p of parts) totalLen += p.length
  const result = new Uint8Array(totalLen)
  let offset = 0
  for (const p of parts) {
    result.set(p, offset)
    offset += p.length
  }
  return result
}

function encode(value: unknown, parts: Uint8Array[], seen: Set<object>): void {
  if (value === null || value === undefined) {
    parts.push(new Uint8Array([0xc0])) // nil
    return
  }

  if (typeof value === 'boolean') {
    parts.push(new Uint8Array([value ? 0xc3 : 0xc2]))
    return
  }

  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      encodeInt(value, parts)
    } else {
      // float 64
      const buf = new Uint8Array(9)
      buf[0] = 0xcb
      new DataView(buf.buffer).setFloat64(1, value, false)
      parts.push(buf)
    }
    return
  }

  if (typeof value === 'string') {
    const encoded = encoder.encode(value)
    const len = encoded.length
    if (len < 32) {
      parts.push(new Uint8Array([0xa0 | len]))
    } else if (len < 0x100) {
      parts.push(new Uint8Array([0xd9, len]))
    } else if (len < 0x10000) {
      parts.push(new Uint8Array([0xda, len >> 8, len & 0xff]))
    } else {
      parts.push(new Uint8Array([0xdb, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]))
    }
    parts.push(encoded)
    return
  }

  if (value instanceof Uint8Array) {
    const len = value.length
    if (len < 0x100) {
      parts.push(new Uint8Array([0xc4, len]))
    } else if (len < 0x10000) {
      parts.push(new Uint8Array([0xc5, len >> 8, len & 0xff]))
    } else {
      parts.push(new Uint8Array([0xc6, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]))
    }
    parts.push(value)
    return
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError('[msgpackEncode] Circular reference detected while encoding array')
    }
    seen.add(value)
    const len = value.length
    if (len < 16) {
      parts.push(new Uint8Array([0x90 | len]))
    } else if (len < 0x10000) {
      parts.push(new Uint8Array([0xdc, len >> 8, len & 0xff]))
    } else {
      parts.push(new Uint8Array([0xdd, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]))
    }
    for (const item of value) {
      encode(item, parts, seen)
    }
    seen.delete(value)
    return
  }

  if (typeof value === 'object') {
    // Fixes #7 H12: reject unsupported non-plain object types explicitly
    // instead of silently encoding them as empty maps (Date) or nil
    // (BigInt/Symbol/Function land here too — well, BigInt does not, but
    // RegExp/Map/Set/Date do). This used to produce silent data loss.
    if (value instanceof Date) {
      throw new TypeError(
        '[msgpackEncode] Date values are not supported in room state. ' +
        'Store timestamps as numbers (e.g. Date.now()) instead.'
      )
    }
    if (value instanceof Map || value instanceof Set) {
      throw new TypeError(
        `[msgpackEncode] ${value.constructor.name} values are not supported in room state. ` +
        'Convert to a plain object/array before calling setState.'
      )
    }
    if (value instanceof RegExp) {
      throw new TypeError('[msgpackEncode] RegExp values are not supported in room state.')
    }
    if (seen.has(value as object)) {
      throw new TypeError('[msgpackEncode] Circular reference detected while encoding object')
    }
    seen.add(value as object)
    const keys = Object.keys(value as Record<string, unknown>)
    const len = keys.length
    if (len < 16) {
      parts.push(new Uint8Array([0x80 | len]))
    } else if (len < 0x10000) {
      parts.push(new Uint8Array([0xde, len >> 8, len & 0xff]))
    } else {
      parts.push(new Uint8Array([0xdf, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]))
    }
    for (const key of keys) {
      encode(key, parts, seen)
      encode((value as Record<string, unknown>)[key], parts, seen)
    }
    seen.delete(value as object)
    return
  }

  // Fixes #7 H12: any remaining non-plain type (BigInt, Symbol, Function)
  // used to be silently encoded as nil — a form of data loss. Throw loudly.
  if (typeof value === 'bigint') {
    throw new TypeError(
      '[msgpackEncode] BigInt values are not supported. ' +
      'Convert to string or number before calling setState.'
    )
  }
  if (typeof value === 'symbol') {
    throw new TypeError('[msgpackEncode] Symbol values are not supported in room state.')
  }
  if (typeof value === 'function') {
    throw new TypeError('[msgpackEncode] Function values are not supported in room state.')
  }

  // Unreachable in practice — all JS types are handled above. If we ever
  // get here, surface it loudly instead of silently writing nil.
  throw new TypeError(`[msgpackEncode] Unsupported value of type ${typeof value}`)
}

function encodeInt(value: number, parts: Uint8Array[]): void {
  if (value >= 0) {
    if (value < 128) {
      parts.push(new Uint8Array([value])) // positive fixint
    } else if (value < 0x100) {
      parts.push(new Uint8Array([0xcc, value])) // uint 8
    } else if (value < 0x10000) {
      parts.push(new Uint8Array([0xcd, value >> 8, value & 0xff])) // uint 16
    } else if (value < 0x100000000) {
      parts.push(new Uint8Array([0xce, (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff])) // uint 32
    } else {
      // Fall back to float64 for large integers
      const buf = new Uint8Array(9)
      buf[0] = 0xcb
      new DataView(buf.buffer).setFloat64(1, value, false)
      parts.push(buf)
    }
  } else {
    if (value >= -32) {
      parts.push(new Uint8Array([value & 0xff])) // negative fixint
    } else if (value >= -128) {
      parts.push(new Uint8Array([0xd0, value & 0xff])) // int 8
    } else if (value >= -32768) {
      const buf = new Uint8Array(3)
      buf[0] = 0xd1
      new DataView(buf.buffer).setInt16(1, value, false)
      parts.push(buf)
    } else if (value >= -2147483648) {
      const buf = new Uint8Array(5)
      buf[0] = 0xd2
      new DataView(buf.buffer).setInt32(1, value, false)
      parts.push(buf)
    } else {
      // Fall back to float64
      const buf = new Uint8Array(9)
      buf[0] = 0xcb
      new DataView(buf.buffer).setFloat64(1, value, false)
      parts.push(buf)
    }
  }
}

function msgpackDecode(buf: Uint8Array): unknown {
  const result = decodeAt(buf, 0)
  return result.value
}

/**
 * Assert that `buf` has at least `need` more bytes starting at `offset`.
 * Fixes #7 H11: before, an underrun would silently return `{ value: null }`
 * and keep decoding, so a truncated frame produced a corrupted object
 * indistinguishable from a legitimate null. We throw instead.
 */
function needBytes(buf: Uint8Array, offset: number, need: number, type: string): void {
  if (offset + need > buf.length) {
    throw new RangeError(
      `[msgpackDecode] Truncated input: ${type} at offset ${offset} needs ${need} more bytes, ` +
      `buffer has ${buf.length - offset}`
    )
  }
}

function decodeAt(buf: Uint8Array, offset: number): { value: unknown; offset: number } {
  needBytes(buf, offset, 1, 'type byte')

  const byte = buf[offset]
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  // Positive fixint (0x00 - 0x7f)
  if (byte < 0x80) return { value: byte, offset: offset + 1 }

  // Fixmap (0x80 - 0x8f)
  if (byte >= 0x80 && byte <= 0x8f) return decodeMap(buf, offset + 1, byte & 0x0f)

  // Fixarray (0x90 - 0x9f)
  if (byte >= 0x90 && byte <= 0x9f) return decodeArray(buf, offset + 1, byte & 0x0f)

  // Fixstr (0xa0 - 0xbf)
  if (byte >= 0xa0 && byte <= 0xbf) {
    const len = byte & 0x1f
    needBytes(buf, offset + 1, len, 'fixstr')
    const str = decoder.decode(buf.subarray(offset + 1, offset + 1 + len))
    return { value: str, offset: offset + 1 + len }
  }

  // Negative fixint (0xe0 - 0xff)
  if (byte >= 0xe0) return { value: byte - 256, offset: offset + 1 }

  switch (byte) {
    // nil
    case 0xc0: return { value: null, offset: offset + 1 }
    // false
    case 0xc2: return { value: false, offset: offset + 1 }
    // true
    case 0xc3: return { value: true, offset: offset + 1 }

    // bin 8
    case 0xc4: {
      needBytes(buf, offset + 1, 1, 'bin8 length')
      const len = buf[offset + 1]
      needBytes(buf, offset + 2, len, 'bin8 data')
      return { value: buf.slice(offset + 2, offset + 2 + len), offset: offset + 2 + len }
    }
    // bin 16
    case 0xc5: {
      needBytes(buf, offset + 1, 2, 'bin16 length')
      const len = view.getUint16(offset + 1, false)
      needBytes(buf, offset + 3, len, 'bin16 data')
      return { value: buf.slice(offset + 3, offset + 3 + len), offset: offset + 3 + len }
    }
    // bin 32
    case 0xc6: {
      needBytes(buf, offset + 1, 4, 'bin32 length')
      const len = view.getUint32(offset + 1, false)
      needBytes(buf, offset + 5, len, 'bin32 data')
      return { value: buf.slice(offset + 5, offset + 5 + len), offset: offset + 5 + len }
    }

    // float 64
    case 0xcb:
      needBytes(buf, offset + 1, 8, 'float64')
      return { value: view.getFloat64(offset + 1, false), offset: offset + 9 }

    // uint 8
    case 0xcc:
      needBytes(buf, offset + 1, 1, 'uint8')
      return { value: buf[offset + 1], offset: offset + 2 }
    // uint 16
    case 0xcd:
      needBytes(buf, offset + 1, 2, 'uint16')
      return { value: view.getUint16(offset + 1, false), offset: offset + 3 }
    // uint 32
    case 0xce:
      needBytes(buf, offset + 1, 4, 'uint32')
      return { value: view.getUint32(offset + 1, false), offset: offset + 5 }

    // int 8
    case 0xd0:
      needBytes(buf, offset + 1, 1, 'int8')
      return { value: view.getInt8(offset + 1), offset: offset + 2 }
    // int 16
    case 0xd1:
      needBytes(buf, offset + 1, 2, 'int16')
      return { value: view.getInt16(offset + 1, false), offset: offset + 3 }
    // int 32
    case 0xd2:
      needBytes(buf, offset + 1, 4, 'int32')
      return { value: view.getInt32(offset + 1, false), offset: offset + 5 }

    // str 8
    case 0xd9: {
      needBytes(buf, offset + 1, 1, 'str8 length')
      const len = buf[offset + 1]
      needBytes(buf, offset + 2, len, 'str8 data')
      return { value: decoder.decode(buf.subarray(offset + 2, offset + 2 + len)), offset: offset + 2 + len }
    }
    // str 16
    case 0xda: {
      needBytes(buf, offset + 1, 2, 'str16 length')
      const len = view.getUint16(offset + 1, false)
      needBytes(buf, offset + 3, len, 'str16 data')
      return { value: decoder.decode(buf.subarray(offset + 3, offset + 3 + len)), offset: offset + 3 + len }
    }
    // str 32
    case 0xdb: {
      needBytes(buf, offset + 1, 4, 'str32 length')
      const len = view.getUint32(offset + 1, false)
      needBytes(buf, offset + 5, len, 'str32 data')
      return { value: decoder.decode(buf.subarray(offset + 5, offset + 5 + len)), offset: offset + 5 + len }
    }

    // array 16
    case 0xdc:
      needBytes(buf, offset + 1, 2, 'array16 count')
      return decodeArray(buf, offset + 3, view.getUint16(offset + 1, false))
    // array 32
    case 0xdd:
      needBytes(buf, offset + 1, 4, 'array32 count')
      return decodeArray(buf, offset + 5, view.getUint32(offset + 1, false))

    // map 16
    case 0xde:
      needBytes(buf, offset + 1, 2, 'map16 count')
      return decodeMap(buf, offset + 3, view.getUint16(offset + 1, false))
    // map 32
    case 0xdf:
      needBytes(buf, offset + 1, 4, 'map32 count')
      return decodeMap(buf, offset + 5, view.getUint32(offset + 1, false))
  }

  // Unknown type — fail loudly instead of silently returning null
  throw new TypeError(`[msgpackDecode] Unknown type byte 0x${byte.toString(16).padStart(2, '0')} at offset ${offset}`)
}

function decodeArray(buf: Uint8Array, offset: number, count: number): { value: unknown[]; offset: number } {
  const arr: unknown[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const result = decodeAt(buf, offset)
    arr[i] = result.value
    offset = result.offset
  }
  return { value: arr, offset }
}

function decodeMap(buf: Uint8Array, offset: number, count: number): { value: Record<string, unknown>; offset: number } {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < count; i++) {
    const keyResult = decodeAt(buf, offset)
    offset = keyResult.offset
    const valResult = decodeAt(buf, offset)
    offset = valResult.offset
    obj[String(keyResult.value)] = valResult.value
  }
  return { value: obj, offset }
}

// ===== Exported Codec Instances =====

export const msgpackCodec: RoomCodec = {
  encode: msgpackEncode,
  decode: msgpackDecode,
}

export const jsonCodec: RoomCodec = {
  encode(data: unknown): Uint8Array {
    return encoder.encode(JSON.stringify(data))
  },
  decode(buf: Uint8Array): unknown {
    return JSON.parse(decoder.decode(buf))
  },
}

// ===== Codec Resolution =====

export type RoomCodecOption = 'msgpack' | 'json' | RoomCodec

export function resolveCodec(option?: RoomCodecOption): RoomCodec {
  if (!option || option === 'msgpack') return msgpackCodec
  if (option === 'json') return jsonCodec
  return option // custom codec
}

// ===== Binary Frame Builders =====

const textEncoder = encoder // reuse

/**
 * Assert that a UTF-8 byte length fits in a u8 length prefix.
 * Fixes #7 H2: silent truncation in buildRoomFrame / buildRoomFrameTail /
 * prependMemberHeader would corrupt the wire and cause parseRoomFrame to
 * return null (dropping the event silently). We throw loudly instead so
 * misuse is obvious in development.
 */
function assertU8Length(label: string, bytes: Uint8Array): void {
  if (bytes.length > 255) {
    throw new Error(
      `[RoomCodec] ${label} is ${bytes.length} bytes after UTF-8 encoding, ` +
      `which exceeds the 255-byte limit of the binary frame u8 length prefix.`
    )
  }
}

function assertU16Length(label: string, bytes: Uint8Array): void {
  if (bytes.length > 0xffff) {
    throw new Error(
      `[RoomCodec] ${label} is ${bytes.length} bytes after UTF-8 encoding, ` +
      `which exceeds the 65535-byte limit of the binary frame u16 length prefix.`
    )
  }
}

/**
 * Build a binary room frame.
 * Format: [frameType:u8][compIdLen:u8][compId:utf8][roomIdLen:u8][roomId:utf8][eventLen:u16BE][event:utf8][payload]
 */
export function buildRoomFrame(
  frameType: number,
  componentId: string,
  roomId: string,
  event: string,
  payload: Uint8Array,
): Uint8Array {
  const compIdBytes = textEncoder.encode(componentId)
  const roomIdBytes = textEncoder.encode(roomId)
  const eventBytes = textEncoder.encode(event)

  assertU8Length('componentId', compIdBytes)
  assertU8Length('roomId', roomIdBytes)
  assertU16Length('event', eventBytes)

  const totalLen = 1 + 1 + compIdBytes.length + 1 + roomIdBytes.length + 2 + eventBytes.length + payload.length
  const frame = new Uint8Array(totalLen)
  let offset = 0

  frame[offset++] = frameType
  frame[offset++] = compIdBytes.length
  frame.set(compIdBytes, offset); offset += compIdBytes.length
  frame[offset++] = roomIdBytes.length
  frame.set(roomIdBytes, offset); offset += roomIdBytes.length
  frame[offset++] = (eventBytes.length >> 8) & 0xff
  frame[offset++] = eventBytes.length & 0xff
  frame.set(eventBytes, offset); offset += eventBytes.length
  frame.set(payload, offset)

  return frame
}

/**
 * Build frame tail (roomId + event + payload) that is shared across all members.
 * Per-member: prepend [frameType:u8][compIdLen:u8][compId:utf8].
 */
export function buildRoomFrameTail(
  roomId: string,
  event: string,
  payload: Uint8Array,
): Uint8Array {
  const roomIdBytes = textEncoder.encode(roomId)
  const eventBytes = textEncoder.encode(event)

  assertU8Length('roomId', roomIdBytes)
  assertU16Length('event', eventBytes)

  const tailLen = 1 + roomIdBytes.length + 2 + eventBytes.length + payload.length
  const tail = new Uint8Array(tailLen)
  let offset = 0

  tail[offset++] = roomIdBytes.length
  tail.set(roomIdBytes, offset); offset += roomIdBytes.length
  tail[offset++] = (eventBytes.length >> 8) & 0xff
  tail[offset++] = eventBytes.length & 0xff
  tail.set(eventBytes, offset); offset += eventBytes.length
  tail.set(payload, offset)

  return tail
}

/**
 * Prepend per-member header to a shared tail.
 * Header: [frameType:u8][compIdLen:u8][compId:utf8]
 */
export function prependMemberHeader(
  frameType: number,
  componentId: string,
  tail: Uint8Array,
): Uint8Array {
  const compIdBytes = textEncoder.encode(componentId)
  assertU8Length('componentId', compIdBytes)
  const frame = new Uint8Array(1 + 1 + compIdBytes.length + tail.length)
  frame[0] = frameType
  frame[1] = compIdBytes.length
  frame.set(compIdBytes, 2)
  frame.set(tail, 2 + compIdBytes.length)
  return frame
}

/**
 * Parse a binary room frame header (client-side).
 * Returns parsed fields and the payload offset.
 */
export function parseRoomFrame(buf: Uint8Array): {
  frameType: number
  componentId: string
  roomId: string
  event: string
  payload: Uint8Array
} | null {
  if (buf.length < 6) return null

  let offset = 0
  const frameType = buf[offset++]

  const compIdLen = buf[offset++]
  if (offset + compIdLen > buf.length) return null
  const componentId = decoder.decode(buf.subarray(offset, offset + compIdLen))
  offset += compIdLen

  const roomIdLen = buf[offset++]
  if (offset + roomIdLen > buf.length) return null
  const roomId = decoder.decode(buf.subarray(offset, offset + roomIdLen))
  offset += roomIdLen

  if (offset + 2 > buf.length) return null
  const eventLen = (buf[offset] << 8) | buf[offset + 1]
  offset += 2

  if (offset + eventLen > buf.length) return null
  const event = decoder.decode(buf.subarray(offset, offset + eventLen))
  offset += eventLen

  const payload = buf.subarray(offset)

  return { frameType, componentId, roomId, event, payload }
}
