// Tests for RoomCodec — msgpack encode/decode, binary frame build/parse, codec resolution
import { describe, it, expect } from 'vitest'
import {
  msgpackCodec,
  jsonCodec,
  resolveCodec,
  buildRoomFrame,
  buildRoomFrameTail,
  prependMemberHeader,
  parseRoomFrame,
  BINARY_ROOM_EVENT,
  BINARY_ROOM_STATE,
  type RoomCodec,
} from '../../rooms/RoomCodec'

// ===== msgpack encode/decode roundtrip =====

describe('msgpackCodec', () => {
  function roundtrip(value: unknown): unknown {
    const encoded = msgpackCodec.encode(value)
    expect(encoded).toBeInstanceOf(Uint8Array)
    return msgpackCodec.decode(encoded)
  }

  describe('primitives', () => {
    it('encodes/decodes null', () => {
      expect(roundtrip(null)).toBe(null)
    })

    it('encodes/decodes undefined as null', () => {
      expect(roundtrip(undefined)).toBe(null)
    })

    it('encodes/decodes true', () => {
      expect(roundtrip(true)).toBe(true)
    })

    it('encodes/decodes false', () => {
      expect(roundtrip(false)).toBe(false)
    })
  })

  describe('integers', () => {
    it('encodes/decodes positive fixint (0-127)', () => {
      expect(roundtrip(0)).toBe(0)
      expect(roundtrip(1)).toBe(1)
      expect(roundtrip(42)).toBe(42)
      expect(roundtrip(127)).toBe(127)
    })

    it('encodes/decodes uint8 (128-255)', () => {
      expect(roundtrip(128)).toBe(128)
      expect(roundtrip(200)).toBe(200)
      expect(roundtrip(255)).toBe(255)
    })

    it('encodes/decodes uint16 (256-65535)', () => {
      expect(roundtrip(256)).toBe(256)
      expect(roundtrip(1000)).toBe(1000)
      expect(roundtrip(65535)).toBe(65535)
    })

    it('encodes/decodes uint32 (65536-4294967295)', () => {
      expect(roundtrip(65536)).toBe(65536)
      expect(roundtrip(1000000)).toBe(1000000)
      expect(roundtrip(4294967295)).toBe(4294967295)
    })

    it('encodes/decodes negative fixint (-1 to -32)', () => {
      expect(roundtrip(-1)).toBe(-1)
      expect(roundtrip(-10)).toBe(-10)
      expect(roundtrip(-32)).toBe(-32)
    })

    it('encodes/decodes int8 (-33 to -128)', () => {
      expect(roundtrip(-33)).toBe(-33)
      expect(roundtrip(-100)).toBe(-100)
      expect(roundtrip(-128)).toBe(-128)
    })

    it('encodes/decodes int16 (-129 to -32768)', () => {
      expect(roundtrip(-129)).toBe(-129)
      expect(roundtrip(-1000)).toBe(-1000)
      expect(roundtrip(-32768)).toBe(-32768)
    })

    it('encodes/decodes int32 (-32769 to -2147483648)', () => {
      expect(roundtrip(-32769)).toBe(-32769)
      expect(roundtrip(-1000000)).toBe(-1000000)
      expect(roundtrip(-2147483648)).toBe(-2147483648)
    })
  })

  describe('floats', () => {
    it('encodes/decodes float64', () => {
      expect(roundtrip(3.14)).toBeCloseTo(3.14)
      expect(roundtrip(-0.5)).toBeCloseTo(-0.5)
      expect(roundtrip(1.23e10)).toBeCloseTo(1.23e10)
    })

    it('encodes/decodes very large integers as float64', () => {
      const big = 2 ** 40
      expect(roundtrip(big)).toBe(big)
    })
  })

  describe('strings', () => {
    it('encodes/decodes empty string', () => {
      expect(roundtrip('')).toBe('')
    })

    it('encodes/decodes fixstr (< 32 bytes)', () => {
      expect(roundtrip('hello')).toBe('hello')
      expect(roundtrip('abc')).toBe('abc')
    })

    it('encodes/decodes str8 (32-255 bytes)', () => {
      const str = 'x'.repeat(100)
      expect(roundtrip(str)).toBe(str)
    })

    it('encodes/decodes str16 (256-65535 bytes)', () => {
      const str = 'y'.repeat(1000)
      expect(roundtrip(str)).toBe(str)
    })

    it('encodes/decodes unicode strings', () => {
      expect(roundtrip('olá mundo')).toBe('olá mundo')
      expect(roundtrip('日本語')).toBe('日本語')
      expect(roundtrip('🎮🏆')).toBe('🎮🏆')
    })
  })

  describe('binary (Uint8Array)', () => {
    it('encodes/decodes small binary', () => {
      const buf = new Uint8Array([1, 2, 3, 4, 5])
      const decoded = roundtrip(buf)
      expect(decoded).toBeInstanceOf(Uint8Array)
      expect(decoded).toEqual(buf)
    })

    it('encodes/decodes empty binary', () => {
      const buf = new Uint8Array(0)
      const decoded = roundtrip(buf)
      expect(decoded).toBeInstanceOf(Uint8Array)
      expect((decoded as Uint8Array).length).toBe(0)
    })
  })

  describe('arrays', () => {
    it('encodes/decodes empty array', () => {
      expect(roundtrip([])).toEqual([])
    })

    it('encodes/decodes fixarray (< 16 elements)', () => {
      expect(roundtrip([1, 2, 3])).toEqual([1, 2, 3])
      expect(roundtrip(['a', 'b'])).toEqual(['a', 'b'])
    })

    it('encodes/decodes array16 (16+ elements)', () => {
      const arr = Array.from({ length: 20 }, (_, i) => i)
      expect(roundtrip(arr)).toEqual(arr)
    })

    it('encodes/decodes mixed type arrays', () => {
      expect(roundtrip([1, 'two', true, null])).toEqual([1, 'two', true, null])
    })

    it('encodes/decodes nested arrays', () => {
      expect(roundtrip([[1, 2], [3, 4]])).toEqual([[1, 2], [3, 4]])
    })
  })

  describe('objects (maps)', () => {
    it('encodes/decodes empty object', () => {
      expect(roundtrip({})).toEqual({})
    })

    it('encodes/decodes fixmap (< 16 keys)', () => {
      const obj = { name: 'test', count: 42, active: true }
      expect(roundtrip(obj)).toEqual(obj)
    })

    it('encodes/decodes map16 (16+ keys)', () => {
      const obj: Record<string, number> = {}
      for (let i = 0; i < 20; i++) obj[`key${i}`] = i
      expect(roundtrip(obj)).toEqual(obj)
    })

    it('encodes/decodes nested objects', () => {
      const obj = { a: { b: { c: 1 } }, d: [1, { e: 2 }] }
      expect(roundtrip(obj)).toEqual(obj)
    })

    it('encodes/decodes null values in objects', () => {
      expect(roundtrip({ x: null })).toEqual({ x: null })
    })
  })

  describe('complex structures (realistic room payloads)', () => {
    it('encodes/decodes a counter room state update', () => {
      const payload = { state: { count: 42, lastUpdatedBy: 'CoolTiger99', onlineCount: 3 } }
      expect(roundtrip(payload)).toEqual(payload)
    })

    it('encodes/decodes a room event', () => {
      const payload = { count: 10, updatedBy: 'HappyPanda55' }
      expect(roundtrip(payload)).toEqual(payload)
    })

    it('encodes/decodes a chat message list', () => {
      const messages = [
        { id: 1, text: 'hello', user: 'alice', timestamp: 1710000000000 },
        { id: 2, text: 'world', user: 'bob', timestamp: 1710000001000 },
      ]
      expect(roundtrip(messages)).toEqual(messages)
    })

    it('encodes/decodes game state with nested arrays and objects', () => {
      const state = {
        players: [
          { id: 'p1', position: { x: 100, y: 200 }, health: 80, inventory: ['sword', 'shield'] },
          { id: 'p2', position: { x: 300, y: 400 }, health: 100, inventory: [] },
        ],
        round: 3,
        active: true,
        winner: null,
      }
      expect(roundtrip(state)).toEqual(state)
    })
  })

  describe('size comparison with JSON', () => {
    it('produces smaller output than JSON for typical payloads', () => {
      const payload = {
        count: 42,
        players: ['Alice', 'Bob', 'Charlie'],
        scores: { Alice: 100, Bob: 85, Charlie: 92 },
        active: true,
      }
      const msgpackSize = msgpackCodec.encode(payload).length
      const jsonSize = new TextEncoder().encode(JSON.stringify(payload)).length

      // msgpack should be smaller
      expect(msgpackSize).toBeLessThan(jsonSize)
    })
  })
})

// ===== jsonCodec =====

describe('jsonCodec', () => {
  it('encodes/decodes objects', () => {
    const data = { count: 42, name: 'test' }
    const encoded = jsonCodec.encode(data)
    expect(encoded).toBeInstanceOf(Uint8Array)
    expect(jsonCodec.decode(encoded)).toEqual(data)
  })

  it('encodes/decodes arrays', () => {
    const data = [1, 'two', true]
    expect(jsonCodec.decode(jsonCodec.encode(data))).toEqual(data)
  })

  it('produces valid UTF-8 JSON', () => {
    const data = { hello: 'world' }
    const encoded = jsonCodec.encode(data)
    const text = new TextDecoder().decode(encoded)
    expect(JSON.parse(text)).toEqual(data)
  })
})

// ===== resolveCodec =====

describe('resolveCodec()', () => {
  it('returns msgpackCodec for undefined', () => {
    expect(resolveCodec()).toBe(msgpackCodec)
  })

  it('returns msgpackCodec for "msgpack"', () => {
    expect(resolveCodec('msgpack')).toBe(msgpackCodec)
  })

  it('returns jsonCodec for "json"', () => {
    expect(resolveCodec('json')).toBe(jsonCodec)
  })

  it('returns custom codec as-is', () => {
    const custom: RoomCodec = {
      encode: (data) => new TextEncoder().encode(String(data)),
      decode: (buf) => new TextDecoder().decode(buf),
    }
    expect(resolveCodec(custom)).toBe(custom)
  })
})

// ===== Binary Frame Constants =====

describe('frame type constants', () => {
  it('has correct values', () => {
    expect(BINARY_ROOM_EVENT).toBe(0x02)
    expect(BINARY_ROOM_STATE).toBe(0x03)
  })
})

// ===== buildRoomFrame / parseRoomFrame roundtrip =====

describe('buildRoomFrame + parseRoomFrame', () => {
  it('roundtrips a ROOM_EVENT frame', () => {
    const payload = msgpackCodec.encode({ count: 42, updatedBy: 'Alice' })
    const frame = buildRoomFrame(BINARY_ROOM_EVENT, 'comp-abc-123', 'counter:global', 'counter:updated', payload)

    const parsed = parseRoomFrame(frame)
    expect(parsed).not.toBeNull()
    expect(parsed!.frameType).toBe(BINARY_ROOM_EVENT)
    expect(parsed!.componentId).toBe('comp-abc-123')
    expect(parsed!.roomId).toBe('counter:global')
    expect(parsed!.event).toBe('counter:updated')

    const data = msgpackCodec.decode(parsed!.payload)
    expect(data).toEqual({ count: 42, updatedBy: 'Alice' })
  })

  it('roundtrips a ROOM_STATE frame', () => {
    const payload = msgpackCodec.encode({ state: { onlineCount: 5 } })
    const frame = buildRoomFrame(BINARY_ROOM_STATE, 'comp-xyz', 'chat:lobby', '$state:update', payload)

    const parsed = parseRoomFrame(frame)
    expect(parsed).not.toBeNull()
    expect(parsed!.frameType).toBe(BINARY_ROOM_STATE)
    expect(parsed!.componentId).toBe('comp-xyz')
    expect(parsed!.roomId).toBe('chat:lobby')
    expect(parsed!.event).toBe('$state:update')

    const data = msgpackCodec.decode(parsed!.payload)
    expect(data).toEqual({ state: { onlineCount: 5 } })
  })

  it('handles empty event name', () => {
    const payload = msgpackCodec.encode({})
    const frame = buildRoomFrame(BINARY_ROOM_STATE, 'c1', 'r1', '', payload)
    const parsed = parseRoomFrame(frame)

    expect(parsed!.event).toBe('')
  })

  it('handles unicode in roomId and event', () => {
    const payload = msgpackCodec.encode({ msg: 'olá' })
    const frame = buildRoomFrame(BINARY_ROOM_EVENT, 'c1', 'sala:geral', 'mensagem:nova', payload)
    const parsed = parseRoomFrame(frame)

    expect(parsed!.roomId).toBe('sala:geral')
    expect(parsed!.event).toBe('mensagem:nova')
    expect(msgpackCodec.decode(parsed!.payload)).toEqual({ msg: 'olá' })
  })

  it('returns null for buffer too short', () => {
    expect(parseRoomFrame(new Uint8Array([0x02, 0x01]))).toBeNull()
    expect(parseRoomFrame(new Uint8Array([]))).toBeNull()
    expect(parseRoomFrame(new Uint8Array([0x02]))).toBeNull()
  })

  it('returns null for truncated componentId', () => {
    // frameType=0x02, compIdLen=10, but only 3 more bytes
    expect(parseRoomFrame(new Uint8Array([0x02, 10, 65, 66, 67]))).toBeNull()
  })

  it('returns null for truncated roomId', () => {
    // Valid compId of length 1, then roomIdLen=50 but buffer too short
    expect(parseRoomFrame(new Uint8Array([0x02, 1, 65, 50]))).toBeNull()
  })
})

// ===== buildRoomFrameTail + prependMemberHeader =====

describe('buildRoomFrameTail + prependMemberHeader', () => {
  it('produces same frame as buildRoomFrame', () => {
    const payload = msgpackCodec.encode({ score: 100 })
    const componentId = 'comp-member-1'
    const roomId = 'game:room'
    const event = 'score:updated'

    // Method 1: single call
    const directFrame = buildRoomFrame(BINARY_ROOM_EVENT, componentId, roomId, event, payload)

    // Method 2: tail + prepend (used for broadcast optimization)
    const tail = buildRoomFrameTail(roomId, event, payload)
    const assembledFrame = prependMemberHeader(BINARY_ROOM_EVENT, componentId, tail)

    expect(assembledFrame).toEqual(directFrame)
  })

  it('allows reusing tail for different componentIds', () => {
    const payload = msgpackCodec.encode({ data: 'shared' })
    const tail = buildRoomFrameTail('room:abc', 'event:x', payload)

    const frame1 = prependMemberHeader(BINARY_ROOM_EVENT, 'comp-1', tail)
    const frame2 = prependMemberHeader(BINARY_ROOM_EVENT, 'comp-2', tail)

    const parsed1 = parseRoomFrame(frame1)
    const parsed2 = parseRoomFrame(frame2)

    expect(parsed1!.componentId).toBe('comp-1')
    expect(parsed2!.componentId).toBe('comp-2')
    expect(parsed1!.roomId).toBe('room:abc')
    expect(parsed2!.roomId).toBe('room:abc')
    expect(msgpackCodec.decode(parsed1!.payload)).toEqual({ data: 'shared' })
    expect(msgpackCodec.decode(parsed2!.payload)).toEqual({ data: 'shared' })
  })

  it('tail is shared: encode once, prepend many', () => {
    const payload = msgpackCodec.encode({ big: 'x'.repeat(500) })
    const tail = buildRoomFrameTail('room:big', 'evt', payload)

    // Build 100 frames with different componentIds
    const frames: Uint8Array[] = []
    for (let i = 0; i < 100; i++) {
      frames.push(prependMemberHeader(BINARY_ROOM_STATE, `comp-${i}`, tail))
    }

    // Verify each parses correctly
    for (let i = 0; i < 100; i++) {
      const parsed = parseRoomFrame(frames[i])
      expect(parsed!.componentId).toBe(`comp-${i}`)
      expect(parsed!.roomId).toBe('room:big')
      expect(parsed!.event).toBe('evt')
    }
  })
})

// ===== Cross-codec compatibility =====

describe('codec interop', () => {
  it('jsonCodec output is decodable by JSON.parse', () => {
    const data = { action: 'move', position: { x: 10, y: 20 } }
    const encoded = jsonCodec.encode(data)
    const text = new TextDecoder().decode(encoded)
    expect(JSON.parse(text)).toEqual(data)
  })

  it('msgpackCodec handles same data as jsonCodec', () => {
    const data = { players: ['Alice', 'Bob'], score: 42, active: true, meta: null }
    const fromMsgpack = msgpackCodec.decode(msgpackCodec.encode(data))
    const fromJson = jsonCodec.decode(jsonCodec.encode(data))
    expect(fromMsgpack).toEqual(fromJson)
  })
})
