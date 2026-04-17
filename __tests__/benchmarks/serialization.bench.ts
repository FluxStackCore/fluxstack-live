/**
 * Serialization Benchmark: JSON vs msgpack vs FlatBuffers vs Manual Encoder
 *
 * Tests encode + decode performance for typical LiveComponent state patterns:
 * - Small delta (counter: 1-2 fields)
 * - Medium delta (form: 5-8 fields)
 * - Full state (dashboard: 20+ fields)
 * - Large array (chat: N messages growing at runtime)
 * - Nested objects (game: players with positions)
 */

import { bench, describe } from 'vitest'
import * as flatbuffers from 'flatbuffers'

// ===== Import our existing msgpack from RoomCodec =====
// We re-implement the relevant parts here since RoomCodec exports the codec object

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// --- Our msgpack (copied from RoomCodec for direct access) ---

function msgpackEncode(value: unknown): Uint8Array {
  const parts: Uint8Array[] = []
  const seen = new Set<object>()
  msgpackEncodeValue(value, parts, seen)
  let totalLen = 0
  for (const p of parts) totalLen += p.length
  const result = new Uint8Array(totalLen)
  let offset = 0
  for (const p of parts) { result.set(p, offset); offset += p.length }
  return result
}

function msgpackEncodeValue(value: unknown, parts: Uint8Array[], seen: Set<object>): void {
  if (value === null || value === undefined) {
    parts.push(new Uint8Array([0xc0]))
    return
  }
  if (typeof value === 'boolean') {
    parts.push(new Uint8Array([value ? 0xc3 : 0xc2]))
    return
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      if (value >= 0 && value < 128) {
        parts.push(new Uint8Array([value]))
      } else if (value < 0 && value >= -32) {
        parts.push(new Uint8Array([value & 0xff]))
      } else if (value >= 0 && value <= 0xff) {
        parts.push(new Uint8Array([0xcc, value]))
      } else if (value >= 0 && value <= 0xffff) {
        parts.push(new Uint8Array([0xcd, (value >> 8) & 0xff, value & 0xff]))
      } else if (value >= 0 && value <= 0xffffffff) {
        parts.push(new Uint8Array([0xce, (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]))
      } else if (value >= -128 && value <= 127) {
        parts.push(new Uint8Array([0xd0, value & 0xff]))
      } else if (value >= -32768 && value <= 32767) {
        parts.push(new Uint8Array([0xd1, (value >> 8) & 0xff, value & 0xff]))
      } else if (value >= -2147483648 && value <= 2147483647) {
        parts.push(new Uint8Array([0xd2, (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]))
      } else {
        const buf = new Uint8Array(9)
        buf[0] = 0xcb
        new DataView(buf.buffer).setFloat64(1, value, false)
        parts.push(buf)
      }
    } else {
      const buf = new Uint8Array(9)
      buf[0] = 0xcb
      new DataView(buf.buffer).setFloat64(1, value, false)
      parts.push(buf)
    }
    return
  }
  if (typeof value === 'string') {
    const encoded = textEncoder.encode(value)
    const len = encoded.length
    if (len < 32) parts.push(new Uint8Array([0xa0 | len]))
    else if (len <= 0xff) parts.push(new Uint8Array([0xd9, len]))
    else if (len <= 0xffff) parts.push(new Uint8Array([0xda, (len >> 8) & 0xff, len & 0xff]))
    else parts.push(new Uint8Array([0xdb, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]))
    parts.push(encoded)
    return
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Circular reference')
    seen.add(value)
    const len = value.length
    if (len < 16) parts.push(new Uint8Array([0x90 | len]))
    else if (len <= 0xffff) parts.push(new Uint8Array([0xdc, (len >> 8) & 0xff, len & 0xff]))
    else parts.push(new Uint8Array([0xdd, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]))
    for (const item of value) msgpackEncodeValue(item, parts, seen)
    seen.delete(value)
    return
  }
  if (typeof value === 'object') {
    if (seen.has(value as object)) throw new TypeError('Circular reference')
    seen.add(value as object)
    const keys = Object.keys(value as object)
    const len = keys.length
    if (len < 16) parts.push(new Uint8Array([0x80 | len]))
    else if (len <= 0xffff) parts.push(new Uint8Array([0xde, (len >> 8) & 0xff, len & 0xff]))
    else parts.push(new Uint8Array([0xdf, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]))
    for (const key of keys) {
      msgpackEncodeValue(key, parts, seen)
      msgpackEncodeValue((value as Record<string, unknown>)[key], parts, seen)
    }
    seen.delete(value as object)
    return
  }
}

function msgpackDecode(buf: Uint8Array): unknown {
  return msgpackDecodeAt(buf, 0).value
}

function msgpackDecodeAt(buf: Uint8Array, offset: number): { value: unknown; offset: number } {
  const byte = buf[offset]
  if (byte < 0x80) return { value: byte, offset: offset + 1 }
  if (byte >= 0xe0) return { value: byte - 256, offset: offset + 1 }
  if (byte >= 0xa0 && byte <= 0xbf) {
    const len = byte & 0x1f
    return { value: textDecoder.decode(buf.subarray(offset + 1, offset + 1 + len)), offset: offset + 1 + len }
  }
  if (byte >= 0x80 && byte <= 0x8f) return msgpackDecodeMap(buf, offset + 1, byte & 0x0f)
  if (byte >= 0x90 && byte <= 0x9f) return msgpackDecodeArray(buf, offset + 1, byte & 0x0f)

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  switch (byte) {
    case 0xc0: return { value: null, offset: offset + 1 }
    case 0xc2: return { value: false, offset: offset + 1 }
    case 0xc3: return { value: true, offset: offset + 1 }
    case 0xcc: return { value: buf[offset + 1], offset: offset + 2 }
    case 0xcd: return { value: view.getUint16(offset + 1, false), offset: offset + 3 }
    case 0xce: return { value: view.getUint32(offset + 1, false), offset: offset + 5 }
    case 0xd0: return { value: view.getInt8(offset + 1), offset: offset + 2 }
    case 0xd1: return { value: view.getInt16(offset + 1, false), offset: offset + 3 }
    case 0xd2: return { value: view.getInt32(offset + 1, false), offset: offset + 5 }
    case 0xcb: return { value: view.getFloat64(offset + 1, false), offset: offset + 9 }
    case 0xd9: {
      const len = buf[offset + 1]
      return { value: textDecoder.decode(buf.subarray(offset + 2, offset + 2 + len)), offset: offset + 2 + len }
    }
    case 0xda: {
      const len = view.getUint16(offset + 1, false)
      return { value: textDecoder.decode(buf.subarray(offset + 3, offset + 3 + len)), offset: offset + 3 + len }
    }
    case 0xdc: return msgpackDecodeArray(buf, offset + 3, view.getUint16(offset + 1, false))
    case 0xdd: return msgpackDecodeArray(buf, offset + 5, view.getUint32(offset + 1, false))
    case 0xde: return msgpackDecodeMap(buf, offset + 3, view.getUint16(offset + 1, false))
    case 0xdf: return msgpackDecodeMap(buf, offset + 5, view.getUint32(offset + 1, false))
  }
  throw new Error(`Unknown msgpack byte: 0x${byte.toString(16)}`)
}

function msgpackDecodeArray(buf: Uint8Array, offset: number, count: number): { value: unknown[]; offset: number } {
  const arr: unknown[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const r = msgpackDecodeAt(buf, offset)
    arr[i] = r.value
    offset = r.offset
  }
  return { value: arr, offset }
}

function msgpackDecodeMap(buf: Uint8Array, offset: number, count: number): { value: Record<string, unknown>; offset: number } {
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < count; i++) {
    const k = msgpackDecodeAt(buf, offset)
    offset = k.offset
    const v = msgpackDecodeAt(buf, offset)
    offset = v.offset
    obj[String(k.value)] = v.value
  }
  return { value: obj, offset }
}

// --- Manual typed encoder (schema-aware, zero overhead) ---

// Encodes known fields into a compact binary format:
// [fieldBitmask(1-4 bytes)] [field values in order]
// Numbers: raw float64 (8 bytes) or varint
// Strings: length(2 bytes) + utf8 bytes
// Booleans: 1 byte

interface FieldSchema {
  name: string
  type: 'number' | 'string' | 'boolean'
}

function createTypedEncoder(schema: FieldSchema[]) {
  const fieldNames = schema.map(f => f.name)
  const fieldTypes = schema.map(f => f.type)
  const encodedFieldNames = fieldNames.map(n => textEncoder.encode(n))

  function encode(obj: Record<string, any>): Uint8Array {
    // Pre-calculate size
    let size = 1 // bitmask byte (up to 8 fields)
    const presentFields: number[] = []

    for (let i = 0; i < schema.length; i++) {
      const val = obj[fieldNames[i]]
      if (val !== undefined) {
        presentFields.push(i)
        switch (fieldTypes[i]) {
          case 'number': size += 8; break
          case 'boolean': size += 1; break
          case 'string': {
            const bytes = textEncoder.encode(val)
            size += 2 + bytes.length
            // Store for later
            ;(obj as any)[`__enc_${i}`] = bytes
            break
          }
        }
      }
    }

    const buf = new Uint8Array(size)
    const view = new DataView(buf.buffer)
    let bitmask = 0
    for (const i of presentFields) bitmask |= (1 << i)
    buf[0] = bitmask

    let offset = 1
    for (const i of presentFields) {
      const val = obj[fieldNames[i]]
      switch (fieldTypes[i]) {
        case 'number':
          view.setFloat64(offset, val, true) // little-endian
          offset += 8
          break
        case 'boolean':
          buf[offset] = val ? 1 : 0
          offset += 1
          break
        case 'string': {
          const bytes = (obj as any)[`__enc_${i}`] as Uint8Array
          delete (obj as any)[`__enc_${i}`]
          view.setUint16(offset, bytes.length, true)
          offset += 2
          buf.set(bytes, offset)
          offset += bytes.length
          break
        }
      }
    }

    return buf
  }

  function decode(buf: Uint8Array): Record<string, any> {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const bitmask = buf[0]
    const result: Record<string, any> = {}
    let offset = 1

    for (let i = 0; i < schema.length; i++) {
      if (!(bitmask & (1 << i))) continue
      switch (fieldTypes[i]) {
        case 'number':
          result[fieldNames[i]] = view.getFloat64(offset, true)
          offset += 8
          break
        case 'boolean':
          result[fieldNames[i]] = buf[offset] === 1
          offset += 1
          break
        case 'string': {
          const len = view.getUint16(offset, true)
          offset += 2
          result[fieldNames[i]] = textDecoder.decode(buf.subarray(offset, offset + len))
          offset += len
          break
        }
      }
    }

    return result
  }

  return { encode, decode }
}

// --- FlatBuffers manual builder (no .fbs schema file needed) ---
// FlatBuffers doesn't have a schemaless mode, so we use its Builder
// to construct a generic key-value table manually.
// This tests the raw FlatBuffers overhead.

function flatbuffersEncode(obj: Record<string, any>): Uint8Array {
  const builder = new flatbuffers.Builder(256)
  const keys = Object.keys(obj)
  const keyOffsets: number[] = []
  const valueOffsets: number[] = []

  // Pre-create all strings
  for (const key of keys) {
    keyOffsets.push(builder.createString(key))
    const val = obj[key]
    if (typeof val === 'string') {
      valueOffsets.push(builder.createString(val))
    } else {
      valueOffsets.push(builder.createString(String(val)))
    }
  }

  // Build entries as tables
  const entryOffsets: number[] = []
  for (let i = 0; i < keys.length; i++) {
    builder.startObject(2)
    builder.addFieldOffset(0, keyOffsets[i], 0)
    builder.addFieldOffset(1, valueOffsets[i], 0)
    entryOffsets.push(builder.endObject())
  }

  // Build root vector
  const entriesVector = flatbuffers.Builder.prototype.createObjectOffsetList
    ? builder.createObjectOffsetList(entryOffsets)
    : (() => {
        builder.startVector(4, entryOffsets.length, 4)
        for (let i = entryOffsets.length - 1; i >= 0; i--) {
          builder.addOffset(entryOffsets[i])
        }
        return builder.endVector()
      })()

  builder.startObject(1)
  builder.addFieldOffset(0, entriesVector, 0)
  const root = builder.endObject()
  builder.finish(root)

  return builder.asUint8Array()
}

// --- Template string encoder (pre-computed envelope) ---

function createTemplateEncoder(componentId: string) {
  const prefix = `{"type":"STATE_DELTA","componentId":"${componentId}","payload":{"delta":`
  const suffix = '}}'

  function encode(delta: Record<string, any>): string {
    return prefix + JSON.stringify(delta) + suffix
  }

  // For comparison: full JSON.stringify
  function encodeFull(delta: Record<string, any>): string {
    return JSON.stringify({
      type: 'STATE_DELTA',
      componentId,
      payload: { delta }
    })
  }

  return { encode, encodeFull }
}

// --- DataView encoder (zero-copy, game-optimized) ---
// Pre-computes field layout from schema, writes directly to ArrayBuffer
// No intermediate objects, no GC pressure

type DataViewFieldType = 'float32' | 'float64' | 'uint8' | 'uint16' | 'uint32' | 'int32' | 'string'

interface DataViewField {
  name: string
  type: DataViewFieldType
  maxStringLen?: number // for strings, pre-allocate max size
}

function createDataViewEncoder(schema: DataViewField[]) {
  // Pre-compute byte offsets
  const fieldOffsets: number[] = []
  const fieldTypes: DataViewFieldType[] = []
  const fieldNames: string[] = []
  let fixedSize = 0

  for (const field of schema) {
    fieldOffsets.push(fixedSize)
    fieldTypes.push(field.type)
    fieldNames.push(field.name)
    switch (field.type) {
      case 'float32': fixedSize += 4; break
      case 'float64': fixedSize += 8; break
      case 'uint8': fixedSize += 1; break
      case 'uint16': fixedSize += 2; break
      case 'uint32': fixedSize += 4; break
      case 'int32': fixedSize += 4; break
      case 'string': fixedSize += 2 + (field.maxStringLen || 64); break
    }
  }

  // Pre-allocate buffer (reused across calls)
  const buffer = new ArrayBuffer(fixedSize)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const enc = new TextEncoder()

  function encode(obj: Record<string, any>): Uint8Array {
    let actualSize = 0
    for (let i = 0; i < schema.length; i++) {
      const val = obj[fieldNames[i]]
      const off = fieldOffsets[i]
      switch (fieldTypes[i]) {
        case 'float32':
          view.setFloat32(off, val, true)
          actualSize = off + 4
          break
        case 'float64':
          view.setFloat64(off, val, true)
          actualSize = off + 8
          break
        case 'uint8':
          bytes[off] = val
          actualSize = off + 1
          break
        case 'uint16':
          view.setUint16(off, val, true)
          actualSize = off + 2
          break
        case 'uint32':
          view.setUint32(off, val, true)
          actualSize = off + 4
          break
        case 'int32':
          view.setInt32(off, val, true)
          actualSize = off + 4
          break
        case 'string': {
          const strBytes = enc.encode(val)
          view.setUint16(off, strBytes.length, true)
          bytes.set(strBytes, off + 2)
          actualSize = off + 2 + strBytes.length
          break
        }
      }
    }
    return bytes.subarray(0, actualSize)
  }

  const dec = new TextDecoder()

  function decode(buf: Uint8Array): Record<string, any> {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const result: Record<string, any> = {}
    for (let i = 0; i < schema.length; i++) {
      const off = fieldOffsets[i]
      switch (fieldTypes[i]) {
        case 'float32':
          result[fieldNames[i]] = v.getFloat32(off, true)
          break
        case 'float64':
          result[fieldNames[i]] = v.getFloat64(off, true)
          break
        case 'uint8':
          result[fieldNames[i]] = buf[off]
          break
        case 'uint16':
          result[fieldNames[i]] = v.getUint16(off, true)
          break
        case 'uint32':
          result[fieldNames[i]] = v.getUint32(off, true)
          break
        case 'int32':
          result[fieldNames[i]] = v.getInt32(off, true)
          break
        case 'string': {
          const len = v.getUint16(off, true)
          result[fieldNames[i]] = dec.decode(buf.subarray(off + 2, off + 2 + len))
          break
        }
      }
    }
    return result
  }

  return { encode, decode, fixedSize }
}

// --- DataView array encoder for game scenarios (batch of players) ---

interface PlayerData {
  x: number
  y: number
  hp: number
  score: number
}

function createGameEncoder(maxPlayers: number) {
  // Layout: [uint32 tick] [uint16 playerCount] [N * (float32 x, float32 y, float32 hp, uint32 score)]
  const PLAYER_SIZE = 4 + 4 + 4 + 4 // 16 bytes per player
  const HEADER_SIZE = 4 + 2 // tick + count
  const buffer = new ArrayBuffer(HEADER_SIZE + maxPlayers * PLAYER_SIZE)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  function encode(tick: number, players: PlayerData[]): Uint8Array {
    view.setUint32(0, tick, true)
    view.setUint16(4, players.length, true)
    for (let i = 0; i < players.length; i++) {
      const off = HEADER_SIZE + i * PLAYER_SIZE
      view.setFloat32(off, players[i].x, true)
      view.setFloat32(off + 4, players[i].y, true)
      view.setFloat32(off + 8, players[i].hp, true)
      view.setUint32(off + 12, players[i].score, true)
    }
    return bytes.subarray(0, HEADER_SIZE + players.length * PLAYER_SIZE)
  }

  function decode(buf: Uint8Array): { tick: number; players: PlayerData[] } {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const tick = v.getUint32(0, true)
    const count = v.getUint16(4, true)
    const players: PlayerData[] = new Array(count)
    for (let i = 0; i < count; i++) {
      const off = HEADER_SIZE + i * PLAYER_SIZE
      players[i] = {
        x: v.getFloat32(off, true),
        y: v.getFloat32(off + 4, true),
        hp: v.getFloat32(off + 8, true),
        score: v.getUint32(off + 12, true),
      }
    }
    return { tick, players }
  }

  return { encode, decode, PLAYER_SIZE, HEADER_SIZE }
}

// ===== Test Data =====

const SMALL_DELTA = { count: 42 }

const MEDIUM_DELTA = {
  name: 'Marcos Silva',
  email: 'marcos@example.com',
  age: 28,
  active: true,
  role: 'admin',
  score: 99.5,
}

const LARGE_STATE = {
  title: 'Dashboard Principal',
  user: 'marcos',
  role: 'admin',
  theme: 'dark',
  locale: 'pt-BR',
  notifications: 42,
  unread: 7,
  lastLogin: 1776278454844,
  sessionDuration: 3600,
  cpuUsage: 45.2,
  memoryUsage: 68.7,
  diskUsage: 55.0,
  networkIn: 1024000,
  networkOut: 512000,
  activeUsers: 150,
  totalRequests: 98765,
  errorRate: 0.02,
  uptime: 99.99,
  version: '1.20.0',
  environment: 'production',
}

// Simulates a chat room with N messages (runtime-growing array)
function createChatState(messageCount: number) {
  const messages = []
  for (let i = 0; i < messageCount; i++) {
    messages.push({
      id: `msg-${i}`,
      user: `user-${i % 10}`,
      text: `Esta é a mensagem número ${i} do chat em tempo real`,
      timestamp: 1776278454844 + i * 1000,
    })
  }
  return { roomId: 'chat-geral', messages, userCount: 10, typing: ['user-1', 'user-3'] }
}

// Simulates a game with N players (nested objects)
function createGameState(playerCount: number) {
  const players: Record<string, any> = {}
  for (let i = 0; i < playerCount; i++) {
    players[`p${i}`] = {
      x: Math.random() * 1000,
      y: Math.random() * 1000,
      hp: 100,
      score: Math.floor(Math.random() * 10000),
      name: `Player${i}`,
    }
  }
  return { tick: 12345, players, mapId: 'arena-1' }
}

const CHAT_10 = createChatState(10)
const CHAT_100 = createChatState(100)
const CHAT_1000 = createChatState(1000)
const GAME_10 = createGameState(10)
const GAME_100 = createGameState(100)

// Schema for typed encoder
const SMALL_SCHEMA: FieldSchema[] = [{ name: 'count', type: 'number' }]
const MEDIUM_SCHEMA: FieldSchema[] = [
  { name: 'name', type: 'string' },
  { name: 'email', type: 'string' },
  { name: 'age', type: 'number' },
  { name: 'active', type: 'boolean' },
  { name: 'role', type: 'string' },
  { name: 'score', type: 'number' },
]

const smallTyped = createTypedEncoder(SMALL_SCHEMA)
const mediumTyped = createTypedEncoder(MEDIUM_SCHEMA)
const templateEncoder = createTemplateEncoder('12UK4TFv')

// DataView encoders
const smallDataView = createDataViewEncoder([
  { name: 'count', type: 'uint32' },
])

const mediumDataView = createDataViewEncoder([
  { name: 'name', type: 'string', maxStringLen: 64 },
  { name: 'email', type: 'string', maxStringLen: 64 },
  { name: 'age', type: 'uint8' },
  { name: 'active', type: 'uint8' }, // boolean as 0/1
  { name: 'role', type: 'string', maxStringLen: 32 },
  { name: 'score', type: 'float64' },
])

// Game encoder: array of players with fixed layout
const gameEncoder10 = createGameEncoder(10)
const gameEncoder100 = createGameEncoder(100)

// Prepare game data as flat arrays for DataView encoder
function createGamePlayersArray(count: number): PlayerData[] {
  const players: PlayerData[] = new Array(count)
  for (let i = 0; i < count; i++) {
    players[i] = {
      x: Math.random() * 1000,
      y: Math.random() * 1000,
      hp: 100,
      score: Math.floor(Math.random() * 10000),
    }
  }
  return players
}

const GAME_PLAYERS_10 = createGamePlayersArray(10)
const GAME_PLAYERS_100 = createGamePlayersArray(100)

// ===== Benchmarks =====

describe('Encode: Small Delta (1 field)', () => {
  bench('JSON.stringify', () => {
    JSON.stringify(SMALL_DELTA)
  })

  bench('JSON template (pre-computed envelope)', () => {
    templateEncoder.encode(SMALL_DELTA)
  })

  bench('JSON full envelope', () => {
    templateEncoder.encodeFull(SMALL_DELTA)
  })

  bench('msgpack', () => {
    msgpackEncode(SMALL_DELTA)
  })

  bench('Manual typed encoder', () => {
    smallTyped.encode({ ...SMALL_DELTA })
  })

  bench('DataView (zero-copy)', () => {
    smallDataView.encode(SMALL_DELTA)
  })

  bench('FlatBuffers', () => {
    flatbuffersEncode(SMALL_DELTA)
  })
})

describe('Decode: Small Delta (1 field)', () => {
  const jsonStr = JSON.stringify(SMALL_DELTA)
  const msgpackBuf = msgpackEncode(SMALL_DELTA)
  const typedBuf = smallTyped.encode({ ...SMALL_DELTA })
  const dvBuf = smallDataView.encode(SMALL_DELTA)

  bench('JSON.parse', () => {
    JSON.parse(jsonStr)
  })

  bench('msgpack', () => {
    msgpackDecode(msgpackBuf)
  })

  bench('Manual typed decoder', () => {
    smallTyped.decode(typedBuf)
  })

  bench('DataView decoder', () => {
    smallDataView.decode(dvBuf)
  })
})

describe('Encode: Medium Delta (6 fields)', () => {
  bench('JSON.stringify', () => {
    JSON.stringify(MEDIUM_DELTA)
  })

  bench('JSON template', () => {
    templateEncoder.encode(MEDIUM_DELTA)
  })

  bench('msgpack', () => {
    msgpackEncode(MEDIUM_DELTA)
  })

  bench('Manual typed encoder', () => {
    mediumTyped.encode({ ...MEDIUM_DELTA })
  })

  bench('DataView (zero-copy)', () => {
    mediumDataView.encode({ ...MEDIUM_DELTA, active: MEDIUM_DELTA.active ? 1 : 0 })
  })

  bench('FlatBuffers', () => {
    flatbuffersEncode(MEDIUM_DELTA)
  })
})

describe('Decode: Medium Delta (6 fields)', () => {
  const jsonStr = JSON.stringify(MEDIUM_DELTA)
  const msgpackBuf = msgpackEncode(MEDIUM_DELTA)
  const typedBuf = mediumTyped.encode({ ...MEDIUM_DELTA })
  const dvBuf = mediumDataView.encode({ ...MEDIUM_DELTA, active: 1 })

  bench('JSON.parse', () => {
    JSON.parse(jsonStr)
  })

  bench('msgpack', () => {
    msgpackDecode(msgpackBuf)
  })

  bench('Manual typed decoder', () => {
    mediumTyped.decode(typedBuf)
  })

  bench('DataView decoder', () => {
    mediumDataView.decode(dvBuf)
  })
})

describe('Encode: Large State (20 fields)', () => {
  bench('JSON.stringify', () => {
    JSON.stringify(LARGE_STATE)
  })

  bench('JSON template', () => {
    templateEncoder.encode(LARGE_STATE)
  })

  bench('msgpack', () => {
    msgpackEncode(LARGE_STATE)
  })

  bench('FlatBuffers', () => {
    flatbuffersEncode(LARGE_STATE)
  })
})

describe('Encode: Chat 10 messages (runtime array)', () => {
  bench('JSON.stringify', () => {
    JSON.stringify(CHAT_10)
  })

  bench('msgpack', () => {
    msgpackEncode(CHAT_10)
  })

  bench('FlatBuffers', () => {
    flatbuffersEncode(CHAT_10 as any)
  })
})

describe('Encode: Chat 100 messages', () => {
  bench('JSON.stringify', () => {
    JSON.stringify(CHAT_100)
  })

  bench('msgpack', () => {
    msgpackEncode(CHAT_100)
  })
})

describe('Encode: Chat 1000 messages', () => {
  bench('JSON.stringify', () => {
    JSON.stringify(CHAT_1000)
  })

  bench('msgpack', () => {
    msgpackEncode(CHAT_1000)
  })
})

describe('Encode: Game 10 players (nested objects)', () => {
  bench('JSON.stringify', () => {
    JSON.stringify(GAME_10)
  })

  bench('msgpack', () => {
    msgpackEncode(GAME_10)
  })

  bench('DataView (zero-copy, binary layout)', () => {
    gameEncoder10.encode(12345, GAME_PLAYERS_10)
  })

  bench('FlatBuffers', () => {
    flatbuffersEncode(GAME_10 as any)
  })
})

describe('Decode: Game 10 players', () => {
  const jsonStr = JSON.stringify(GAME_10)
  const msgpackBuf = msgpackEncode(GAME_10)
  const dvBuf = gameEncoder10.encode(12345, GAME_PLAYERS_10)

  bench('JSON.parse', () => {
    JSON.parse(jsonStr)
  })

  bench('msgpack', () => {
    msgpackDecode(msgpackBuf)
  })

  bench('DataView decoder', () => {
    gameEncoder10.decode(dvBuf)
  })
})

describe('Encode: Game 100 players', () => {
  bench('JSON.stringify', () => {
    JSON.stringify(GAME_100)
  })

  bench('msgpack', () => {
    msgpackEncode(GAME_100)
  })

  bench('DataView (zero-copy, binary layout)', () => {
    gameEncoder100.encode(12345, GAME_PLAYERS_100)
  })
})

describe('Decode: Game 100 players', () => {
  const jsonStr = JSON.stringify(GAME_100)
  const msgpackBuf = msgpackEncode(GAME_100)
  const dvBuf = gameEncoder100.encode(12345, GAME_PLAYERS_100)

  bench('JSON.parse', () => {
    JSON.parse(jsonStr)
  })

  bench('msgpack', () => {
    msgpackDecode(msgpackBuf)
  })

  bench('DataView decoder', () => {
    gameEncoder100.decode(dvBuf)
  })
})

// ===== Wire Size Comparison =====

describe('Wire Size (bytes)', () => {
  bench('JSON small', () => {
    JSON.stringify(SMALL_DELTA).length
  })

  bench('msgpack small', () => {
    msgpackEncode(SMALL_DELTA).length
  })

  bench('typed small', () => {
    smallTyped.encode({ ...SMALL_DELTA }).length
  })

  bench('DataView small', () => {
    smallDataView.encode(SMALL_DELTA).length
  })
})

// ===== Round-trip (encode + decode) =====

describe('Round-trip: Medium Delta', () => {
  bench('JSON', () => {
    JSON.parse(JSON.stringify(MEDIUM_DELTA))
  })

  bench('msgpack', () => {
    msgpackDecode(msgpackEncode(MEDIUM_DELTA))
  })

  bench('Manual typed', () => {
    mediumTyped.decode(mediumTyped.encode({ ...MEDIUM_DELTA }))
  })

  bench('DataView', () => {
    mediumDataView.decode(mediumDataView.encode({ ...MEDIUM_DELTA, active: 1 }))
  })
})

describe('Round-trip: Large State', () => {
  bench('JSON', () => {
    JSON.parse(JSON.stringify(LARGE_STATE))
  })

  bench('msgpack', () => {
    msgpackDecode(msgpackEncode(LARGE_STATE))
  })
})

describe('Round-trip: Game 10 players', () => {
  bench('JSON', () => {
    JSON.parse(JSON.stringify(GAME_10))
  })

  bench('msgpack', () => {
    msgpackDecode(msgpackEncode(GAME_10))
  })

  bench('DataView', () => {
    gameEncoder10.decode(gameEncoder10.encode(12345, GAME_PLAYERS_10))
  })
})

describe('Round-trip: Game 100 players', () => {
  bench('JSON', () => {
    JSON.parse(JSON.stringify(GAME_100))
  })

  bench('msgpack', () => {
    msgpackDecode(msgpackEncode(GAME_100))
  })

  bench('DataView', () => {
    gameEncoder100.decode(gameEncoder100.encode(12345, GAME_PLAYERS_100))
  })
})

// ===== JSON Compression =====
// Test: JSON.stringify → compress → send → decompress → JSON.parse

import { deflateSync, inflateSync } from 'zlib'

const GAME_DELTA_COMPRESS = { x: 42.5, y: 100.0, hp: 80, score: 99999, level: 15 }

const jsonSmallStr = JSON.stringify(SMALL_DELTA)
const jsonMediumStr = JSON.stringify(MEDIUM_DELTA)
const jsonLargeStr = JSON.stringify(LARGE_STATE)
const jsonGameStr = JSON.stringify(GAME_DELTA_COMPRESS)
const jsonGame100Str = JSON.stringify(GAME_100)
const jsonChat100Str = JSON.stringify(CHAT_100)

// Pre-compress for decode benchmarks
const deflatedSmall = deflateSync(jsonSmallStr)
const deflatedMedium = deflateSync(jsonMediumStr)
const deflatedLarge = deflateSync(jsonLargeStr)
const deflatedGame = deflateSync(jsonGameStr)
const deflatedGame100 = deflateSync(jsonGame100Str)
const deflatedChat100 = deflateSync(jsonChat100Str)

describe('Compression: Encode (stringify + compress)', () => {
  bench('JSON only (small)', () => {
    JSON.stringify(SMALL_DELTA)
  })

  bench('JSON + deflate (small)', () => {
    deflateSync(JSON.stringify(SMALL_DELTA))
  })

  bench('JSON only (medium)', () => {
    JSON.stringify(MEDIUM_DELTA)
  })

  bench('JSON + deflate (medium)', () => {
    deflateSync(JSON.stringify(MEDIUM_DELTA))
  })

  bench('JSON only (large)', () => {
    JSON.stringify(LARGE_STATE)
  })

  bench('JSON + deflate (large)', () => {
    deflateSync(JSON.stringify(LARGE_STATE))
  })

  bench('JSON only (game 100p)', () => {
    JSON.stringify(GAME_100)
  })

  bench('JSON + deflate (game 100p)', () => {
    deflateSync(JSON.stringify(GAME_100))
  })

  bench('JSON only (chat 100)', () => {
    JSON.stringify(CHAT_100)
  })

  bench('JSON + deflate (chat 100)', () => {
    deflateSync(JSON.stringify(CHAT_100))
  })
})

describe('Compression: Decode (decompress + parse)', () => {
  bench('JSON.parse only (small)', () => {
    JSON.parse(jsonSmallStr)
  })

  bench('inflate + JSON.parse (small)', () => {
    JSON.parse(inflateSync(deflatedSmall).toString())
  })

  bench('JSON.parse only (medium)', () => {
    JSON.parse(jsonMediumStr)
  })

  bench('inflate + JSON.parse (medium)', () => {
    JSON.parse(inflateSync(deflatedMedium).toString())
  })

  bench('JSON.parse only (game 100p)', () => {
    JSON.parse(jsonGame100Str)
  })

  bench('inflate + JSON.parse (game 100p)', () => {
    JSON.parse(inflateSync(deflatedGame100).toString())
  })

  bench('JSON.parse only (chat 100)', () => {
    JSON.parse(jsonChat100Str)
  })

  bench('inflate + JSON.parse (chat 100)', () => {
    JSON.parse(inflateSync(deflatedChat100).toString())
  })
})

describe('Compression: Round-trip', () => {
  bench('JSON only (game delta)', () => {
    JSON.parse(JSON.stringify(GAME_DELTA_COMPRESS))
  })

  bench('JSON + deflate/inflate (game delta)', () => {
    JSON.parse(inflateSync(deflateSync(JSON.stringify(GAME_DELTA_COMPRESS))).toString())
  })

  bench('JSON only (game 100p)', () => {
    JSON.parse(JSON.stringify(GAME_100))
  })

  bench('JSON + deflate/inflate (game 100p)', () => {
    JSON.parse(inflateSync(deflateSync(JSON.stringify(GAME_100))).toString())
  })

  bench('JSON only (chat 100)', () => {
    JSON.parse(JSON.stringify(CHAT_100))
  })

  bench('JSON + deflate/inflate (chat 100)', () => {
    JSON.parse(inflateSync(deflateSync(JSON.stringify(CHAT_100))).toString())
  })
})

// ===== BinaryStateCodec (the real implementation) =====

import { BinaryStateCodec } from '../../packages/core/src/protocol/BinaryStateCodec'

// Auto-infer mode
const codecSmallAuto = new BinaryStateCodec({ count: 42 })
const codecMediumAuto = new BinaryStateCodec(MEDIUM_DELTA)
const codecGameAuto = new BinaryStateCodec({ x: 0, y: 0, hp: 100, score: 0, level: 1 })

// Typed mode (game-optimized)
const codecGameTyped = new BinaryStateCodec(
  { x: 0, y: 0, hp: 100, score: 0, level: 1 },
  { x: 'float32', y: 'float32', hp: 'uint8', score: 'uint32', level: 'uint8' }
)

const GAME_DELTA = { x: 42.5, y: 100.0, hp: 80, score: 99999, level: 15 }

describe('BinaryStateCodec: Encode', () => {
  bench('JSON.stringify (small)', () => {
    JSON.stringify(SMALL_DELTA)
  })

  bench('Codec auto (small)', () => {
    codecSmallAuto.encodeDelta(SMALL_DELTA)
  })

  bench('JSON.stringify (medium)', () => {
    JSON.stringify(MEDIUM_DELTA)
  })

  bench('Codec auto (medium)', () => {
    codecMediumAuto.encodeDelta(MEDIUM_DELTA)
  })

  bench('JSON.stringify (game delta)', () => {
    JSON.stringify(GAME_DELTA)
  })

  bench('Codec auto (game delta)', () => {
    codecGameAuto.encodeDelta(GAME_DELTA)
  })

  bench('Codec typed (game delta)', () => {
    codecGameTyped.encodeDelta(GAME_DELTA)
  })
})

describe('BinaryStateCodec: Decode', () => {
  const jsonSmall = JSON.stringify(SMALL_DELTA)
  const jsonMedium = JSON.stringify(MEDIUM_DELTA)
  const jsonGame = JSON.stringify(GAME_DELTA)
  const binSmall = codecSmallAuto.encodeDelta(SMALL_DELTA).binary!
  const binMedium = codecMediumAuto.encodeDelta(MEDIUM_DELTA).binary!
  const binGameAuto = codecGameAuto.encodeDelta(GAME_DELTA).binary!
  const binGameTyped = codecGameTyped.encodeDelta(GAME_DELTA).binary!

  bench('JSON.parse (small)', () => {
    JSON.parse(jsonSmall)
  })

  bench('Codec auto decode (small)', () => {
    codecSmallAuto.decodeDelta(binSmall)
  })

  bench('JSON.parse (medium)', () => {
    JSON.parse(jsonMedium)
  })

  bench('Codec auto decode (medium)', () => {
    codecMediumAuto.decodeDelta(binMedium)
  })

  bench('JSON.parse (game)', () => {
    JSON.parse(jsonGame)
  })

  bench('Codec auto decode (game)', () => {
    codecGameAuto.decodeDelta(binGameAuto)
  })

  bench('Codec typed decode (game)', () => {
    codecGameTyped.decodeDelta(binGameTyped)
  })
})

describe('BinaryStateCodec: Round-trip', () => {
  bench('JSON (game delta)', () => {
    JSON.parse(JSON.stringify(GAME_DELTA))
  })

  bench('Codec auto (game delta)', () => {
    codecGameAuto.decodeDelta(codecGameAuto.encodeDelta(GAME_DELTA).binary!)
  })

  bench('Codec typed (game delta)', () => {
    codecGameTyped.decodeDelta(codecGameTyped.encodeDelta(GAME_DELTA).binary!)
  })
})

describe('BinaryStateCodec: Full envelope vs binary frame', () => {
  // Simulates the real path: JSON envelope (current) vs binary frame (new)
  const componentId = '12UK4TFv'
  const idBytes = new TextEncoder().encode(componentId)

  bench('JSON envelope (current path)', () => {
    JSON.stringify({
      type: 'STATE_DELTA',
      componentId,
      payload: { delta: GAME_DELTA }
    })
  })

  bench('Binary frame (new path, auto)', () => {
    const { binary } = codecGameAuto.encodeDelta(GAME_DELTA)
    const frame = new Uint8Array(1 + 1 + idBytes.length + binary!.length)
    frame[0] = 0x01
    frame[1] = idBytes.length
    frame.set(idBytes, 2)
    frame.set(binary!, 2 + idBytes.length)
  })

  bench('Binary frame (new path, typed)', () => {
    const { binary } = codecGameTyped.encodeDelta(GAME_DELTA)
    const frame = new Uint8Array(1 + 1 + idBytes.length + binary!.length)
    frame[0] = 0x01
    frame[1] = idBytes.length
    frame.set(idBytes, 2)
    frame.set(binary!, 2 + idBytes.length)
  })
})

// ===== Print wire sizes for reference =====

import { test, expect } from 'vitest'

test('Wire size comparison', () => {
  const results: Record<string, Record<string, number>> = {}

  const datasets = {
    'Small (1 field)': SMALL_DELTA,
    'Medium (6 fields)': MEDIUM_DELTA,
    'Large (20 fields)': LARGE_STATE,
    'Chat 10 msgs': CHAT_10,
    'Chat 100 msgs': CHAT_100,
    'Chat 1000 msgs': CHAT_1000,
    'Game 10 players': GAME_10,
    'Game 100 players': GAME_100,
  }

  for (const [label, data] of Object.entries(datasets)) {
    const jsonSize = JSON.stringify(data).length
    const msgpackSize = msgpackEncode(data).length
    const fullEnvelope = JSON.stringify({
      type: 'STATE_DELTA',
      componentId: '12UK4TFv',
      payload: { delta: data }
    }).length

    results[label] = {
      'JSON (delta only)': jsonSize,
      'JSON (full envelope)': fullEnvelope,
      'msgpack': msgpackSize,
      'envelope overhead': fullEnvelope - jsonSize,
    }
  }

  console.log('\n===== WIRE SIZE COMPARISON =====')
  for (const [label, sizes] of Object.entries(results)) {
    console.log(`\n${label}:`)
    for (const [format, size] of Object.entries(sizes)) {
      console.log(`  ${format}: ${size} bytes`)
    }
    const saving = Math.round((1 - sizes['msgpack'] / sizes['JSON (delta only)']) * 100)
    console.log(`  msgpack saving: ${saving}%`)
  }

  // Typed encoder sizes (only for compatible schemas)
  console.log('\n--- Typed Encoder ---')
  const smallTypedSize = smallTyped.encode({ ...SMALL_DELTA }).length
  const mediumTypedSize = mediumTyped.encode({ ...MEDIUM_DELTA }).length
  console.log(`  Small: ${smallTypedSize} bytes (JSON: ${JSON.stringify(SMALL_DELTA).length}, msgpack: ${msgpackEncode(SMALL_DELTA).length})`)
  console.log(`  Medium: ${mediumTypedSize} bytes (JSON: ${JSON.stringify(MEDIUM_DELTA).length}, msgpack: ${msgpackEncode(MEDIUM_DELTA).length})`)

  // DataView sizes
  console.log('\n--- DataView (zero-copy) ---')
  const smallDvSize = smallDataView.encode(SMALL_DELTA).length
  const mediumDvSize = mediumDataView.encode({ ...MEDIUM_DELTA, active: 1 }).length
  const game10DvSize = gameEncoder10.encode(12345, GAME_PLAYERS_10).length
  const game100DvSize = gameEncoder100.encode(12345, GAME_PLAYERS_100).length
  console.log(`  Small: ${smallDvSize} bytes (JSON: ${JSON.stringify(SMALL_DELTA).length})`)
  console.log(`  Medium: ${mediumDvSize} bytes (JSON: ${JSON.stringify(MEDIUM_DELTA).length})`)
  console.log(`  Game 10p: ${game10DvSize} bytes (JSON: ${JSON.stringify(GAME_10).length}, msgpack: ${msgpackEncode(GAME_10).length})`)
  console.log(`  Game 100p: ${game100DvSize} bytes (JSON: ${JSON.stringify(GAME_100).length}, msgpack: ${msgpackEncode(GAME_100).length})`)

  // Compression sizes
  console.log('\n--- JSON + Deflate Compression ---')
  for (const [label, data] of Object.entries(datasets)) {
    const jsonStr = JSON.stringify(data)
    const compressed = deflateSync(jsonStr)
    const ratio = Math.round((1 - compressed.length / jsonStr.length) * 100)
    console.log(`  ${label}: ${jsonStr.length} → ${compressed.length} bytes (${ratio}% smaller)`)
  }

  // BinaryStateCodec sizes (the real implementation)
  console.log('\n--- BinaryStateCodec ---')
  const codecSmallSize = codecSmallAuto.encodeDelta(SMALL_DELTA).binary!.length
  const codecMediumSize = codecMediumAuto.encodeDelta(MEDIUM_DELTA).binary!.length
  const codecGameAutoSize = codecGameAuto.encodeDelta(GAME_DELTA).binary!.length
  const codecGameTypedSize = codecGameTyped.encodeDelta(GAME_DELTA).binary!.length
  const jsonGameSize = JSON.stringify(GAME_DELTA).length
  const jsonGameEnvelope = JSON.stringify({ type: 'STATE_DELTA', componentId: '12UK4TFv', payload: { delta: GAME_DELTA } }).length
  console.log(`  Small auto: ${codecSmallSize} bytes (JSON: ${JSON.stringify(SMALL_DELTA).length})`)
  console.log(`  Medium auto: ${codecMediumSize} bytes (JSON: ${JSON.stringify(MEDIUM_DELTA).length})`)
  console.log(`  Game auto:  ${codecGameAutoSize} bytes (JSON delta: ${jsonGameSize}, JSON envelope: ${jsonGameEnvelope})`)
  console.log(`  Game typed: ${codecGameTypedSize} bytes (${Math.round((1 - codecGameTypedSize / jsonGameEnvelope) * 100)}% smaller than JSON envelope)`)
  // Binary frame size (header + id + payload)
  const frameAuto = 1 + 1 + 8 + codecGameAutoSize  // 0x01 + idLen + 8 bytes id + payload
  const frameTyped = 1 + 1 + 8 + codecGameTypedSize
  console.log(`  Frame auto:  ${frameAuto} bytes total on wire`)
  console.log(`  Frame typed: ${frameTyped} bytes total on wire (vs ${jsonGameEnvelope} JSON envelope)`)

  expect(true).toBe(true)
})
